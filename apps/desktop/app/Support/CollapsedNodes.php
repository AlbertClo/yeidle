<?php

namespace App\Support;

use App\Import\Roam\RoamPosition;
use App\Models\Node;
use App\Models\SyncState;
use App\Sync\CloudSyncService;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;

/**
 * Personal collapse state stored in the normal synced node graph:
 *
 *   hidden workspace root -> hidden account root -> collapsed node IDs
 *
 * Expansion is represented by the absence of an entry. Collapsing a node
 * clears entries below it; expanding clears the complete requested subtree.
 */
final class CollapsedNodes
{
    public const ROOT_ID = SystemNodes::COLLAPSED_NODES_ROOT_ID;

    public function __construct(
        private SyncService $sync,
        private CloudSyncService $cloud,
    ) {}

    /** @return array{root_id: string, node_ids: list<string>} */
    public function listing(): array
    {
        $rootId = $this->activeRootId();

        return [
            'root_id' => $rootId,
            'node_ids' => $this->entries($rootId)
                ->pluck('content')
                ->filter(fn (mixed $id): bool => is_string($id) && $id !== '')
                ->values()
                ->all(),
        ];
    }

    public function collapse(Node $node): void
    {
        abort_unless(! $node->isPage() && $node->isReachable()
            && ! $node->isSystemNode(), 404);

        DB::transaction(function () use ($node): void {
            $rootId = $this->activeRootId();
            $subtreeIds = $this->subtreeIds([$node->id]);
            $clock = $this->clock();
            $hlc = $clock->now();
            $ops = $this->containerOps($rootId, $clock);

            foreach ($this->entriesForNodeIds($rootId, $subtreeIds) as $entry) {
                if ($entry->content !== $node->id) {
                    $ops[] = $this->deleteOp($entry->id, $rootId, $hlc);
                }
            }

            $entryId = $this->entryId($rootId, $node->id);

            if (! Node::query()->whereKey($entryId)->whereNull('deleted_at')->exists()) {
                $ops[] = $this->setOp($entryId, $rootId, $hlc, [
                    'parent_id' => $rootId,
                    'position' => RoamPosition::at(0),
                    'content' => $node->id,
                    'tiptap_content' => null,
                    'is_checked' => null,
                ]);
            }

            $this->sync->push($ops);
        });
    }

    /** @param list<Node> $nodes */
    public function expand(array $nodes): void
    {
        DB::transaction(function () use ($nodes): void {
            $rootId = $this->activeRootId();
            $subtreeIds = $this->subtreeIds(
                collect($nodes)
                    ->filter(fn (Node $node): bool => ! $node->isPage()
                        && $node->isReachable()
                        && ! $node->isSystemNode())
                    ->pluck('id')
                    ->all(),
            );

            if ($subtreeIds === []) {
                return;
            }

            $entries = $this->entriesForNodeIds($rootId, $subtreeIds);

            if ($entries->isEmpty()) {
                return;
            }

            $clock = $this->clock();
            $hlc = $clock->now();
            $ops = $entries
                ->map(fn (Node $entry): array => $this->deleteOp(
                    $entry->id,
                    $rootId,
                    $hlc,
                ))
                ->all();

            $this->sync->push($ops);
        });
    }

    public function activeRootId(): string
    {
        $state = SyncState::current();

        if ($state === null) {
            $state = SyncState::create([
                'client_id' => (string) Str::uuid7(),
                'last_server_seq' => 0,
            ]);
        }

        if ($state->cloud_url && $state->workspace_id && ! $state->cloud_user_id) {
            try {
                $this->cloud->refreshCloudUserId();
                $state->refresh();
            } catch (\Throwable) {
                // Collapse state remains fully local while cloud is offline.
            }
        }

        $localRootId = $this->userRootId('local:'.$state->client_id);

        if (! is_string($state->cloud_user_id) || $state->cloud_user_id === '') {
            return $localRootId;
        }

        $cloudRootId = $this->userRootId('cloud:'.$state->cloud_user_id);
        $this->adoptAccountRoot($localRootId, $cloudRootId);

        return $cloudRootId;
    }

    private function adoptAccountRoot(string $localRootId, string $cloudRootId): void
    {
        if ($localRootId === $cloudRootId || Node::query()->find($localRootId) === null) {
            return;
        }

        $localEntries = $this->entries($localRootId);
        $cloudEntries = $this->entries($cloudRootId)->keyBy('content');
        $clock = $this->clock();
        $hlc = $clock->now();
        $ops = $this->containerOps($cloudRootId, $clock);

        foreach ($localEntries as $entry) {
            if (! $cloudEntries->has($entry->content)) {
                $ops[] = $this->setOp(
                    $this->entryId($cloudRootId, $entry->content),
                    $cloudRootId,
                    $hlc,
                    [
                        'parent_id' => $cloudRootId,
                        'position' => $entry->position,
                        'content' => $entry->content,
                        'tiptap_content' => null,
                        'is_checked' => null,
                    ],
                );
            }

            $ops[] = $this->deleteOp($entry->id, $localRootId, $hlc);
        }

        $ops[] = $this->deleteOp($localRootId, self::ROOT_ID, $hlc);
        $this->sync->push($ops);
    }

    /** @return Collection<int, Node> */
    private function entries(string $rootId): Collection
    {
        return Node::query()
            ->where('parent_id', $rootId)
            ->orderBy('id')
            ->get();
    }

    /** @param list<string> $nodeIds @return Collection<int, Node> */
    private function entriesForNodeIds(string $rootId, array $nodeIds): Collection
    {
        if ($nodeIds === []) {
            return collect();
        }

        $nodeIdSet = array_fill_keys($nodeIds, true);

        return $this->entries($rootId)
            ->filter(fn (Node $entry): bool => isset($nodeIdSet[$entry->content]))
            ->values();
    }

    /** @param list<string> $rootIds @return list<string> */
    private function subtreeIds(array $rootIds): array
    {
        if ($rootIds === []) {
            return [];
        }

        $placeholders = implode(', ', array_fill(0, count($rootIds), '?'));
        $rows = DB::select(<<<SQL
            WITH RECURSIVE subtree AS (
                SELECT id
                FROM nodes
                WHERE id IN ({$placeholders})
                    AND deleted_at IS NULL

                UNION

                SELECT nodes.id
                FROM nodes
                INNER JOIN subtree ON nodes.parent_id = subtree.id
                WHERE nodes.deleted_at IS NULL
            )
            SELECT id FROM subtree
        SQL, $rootIds);

        return array_values(array_map(
            fn (object $row): string => $row->id,
            $rows,
        ));
    }

    /** @return list<array<string, mixed>> */
    private function containerOps(string $userRootId, HlcGenerator $clock): array
    {
        return [
            $this->setOp(self::ROOT_ID, self::ROOT_ID, $clock->now(), [
                'parent_id' => null,
                'position' => 'a0',
                'content' => '',
                'tiptap_content' => null,
                'is_checked' => null,
            ]),
            $this->setOp($userRootId, self::ROOT_ID, $clock->now(), [
                'parent_id' => self::ROOT_ID,
                'position' => 'a0',
                'content' => '',
                'tiptap_content' => null,
                'is_checked' => null,
            ]),
        ];
    }

    /** @param array<string, mixed> $fields */
    private function setOp(string $id, string $pageId, string $hlc, array $fields): array
    {
        return [
            'op_id' => (string) Str::uuid7(),
            'client_id' => $this->opClientId($hlc),
            'hlc' => $hlc,
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $pageId,
                'fields' => $fields,
            ],
        ];
    }

    private function deleteOp(string $id, string $pageId, string $hlc): array
    {
        return [
            'op_id' => (string) Str::uuid7(),
            'client_id' => $this->opClientId($hlc),
            'hlc' => $hlc,
            'type' => 'node.delete',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $pageId,
            ],
        ];
    }

    private function clock(): HlcGenerator
    {
        return new HlcGenerator('collapsed-nodes-'.Str::uuid7());
    }

    private function opClientId(string $hlc): string
    {
        return substr($hlc, 21);
    }

    private function userRootId(string $identity): string
    {
        return Uuid::uuid5(self::ROOT_ID, $identity)->toString();
    }

    private function entryId(string $rootId, string $nodeId): string
    {
        return Uuid::uuid5($rootId, $nodeId)->toString();
    }
}
