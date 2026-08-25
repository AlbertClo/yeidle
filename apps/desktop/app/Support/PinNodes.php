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
 * Pins live in the normal synced node graph:
 *
 *   hidden workspace root -> hidden account root -> pin entries
 *
 * The workspace root is shared, while the account root is UUIDv5-derived
 * from the authenticated cloud user. Every replica therefore stores all
 * users' pins, but presents only the current user's root.
 */
final class PinNodes
{
    public const ROOT_ID = SystemNodes::PINS_ROOT_ID;

    public function __construct(
        private SyncService $sync,
        private CloudSyncService $cloud,
    ) {}

    /** @return array{root_id: string, items: Collection<int, Node>} */
    public function listing(): array
    {
        $rootId = $this->activeRootId();
        $entries = $this->entries($rootId);
        $itemsById = Node::query()
            ->whereKey($entries->pluck('content')->filter()->unique())
            ->get()
            ->keyBy('id');

        return [
            'root_id' => $rootId,
            'items' => $entries
                ->map(fn (Node $entry): ?Node => $itemsById->get($entry->content))
                ->filter(fn (?Node $item): bool => $item?->isPage() === true
                    && $item->isReachable()
                    && ! $item->isSystemNode())
                ->values(),
        ];
    }

    public function isPinned(Node|string $node): bool
    {
        $nodeId = $node instanceof Node ? $node->id : $node;

        return Node::query()
            ->whereKey($this->entryId($this->activeRootId(), $nodeId))
            ->whereNull('deleted_at')
            ->exists();
    }

    public function add(Node $node): void
    {
        abort_unless($node->isPage() && $node->isReachable()
            && ! $node->isSystemNode(), 404);

        DB::transaction(function () use ($node): void {
            $rootId = $this->activeRootId();
            $entryId = $this->entryId($rootId, $node->id);

            if (Node::query()->whereKey($entryId)->whereNull('deleted_at')->exists()) {
                return;
            }

            $clock = $this->clock();
            $hlc = $clock->now();
            $ops = $this->containerOps($rootId, $clock);
            $entries = $this->entries($rootId);

            foreach ($entries as $index => $entry) {
                $ops[] = $this->setOp($entry->id, $rootId, $hlc, [
                    'position' => RoamPosition::at($index),
                ]);
            }

            $ops[] = $this->setOp($entryId, $rootId, $hlc, [
                'parent_id' => $rootId,
                'position' => RoamPosition::at($entries->count()),
                'content' => $node->id,
                'tiptap_content' => null,
                'is_checked' => null,
            ]);

            $this->sync->push($ops);
        });
    }

    public function remove(string $nodeId): void
    {
        DB::transaction(function () use ($nodeId): void {
            $rootId = $this->activeRootId();
            $entry = Node::query()->find($this->entryId($rootId, $nodeId));

            if ($entry === null) {
                return;
            }

            $clock = $this->clock();
            $this->sync->push([$this->deleteOp($entry->id, $rootId, $clock->now())]);
        });
    }

    /** @param list<string> $nodeIds */
    public function reorder(array $nodeIds): bool
    {
        return DB::transaction(function () use ($nodeIds): bool {
            $rootId = $this->activeRootId();
            $entries = $this->entries($rootId);
            $entriesByNode = $entries->keyBy('content');

            if (count($nodeIds) !== $entries->count()
                || collect($nodeIds)->contains(
                    fn (string $nodeId): bool => ! $entriesByNode->has($nodeId)
                )) {
                return false;
            }

            $clock = $this->clock();
            // One HLC makes the reordered list a coherent LWW update: a
            // concurrent reorder cannot leave a mixture of both orders.
            $hlc = $clock->now();
            $ops = [];

            foreach ($nodeIds as $index => $nodeId) {
                $entry = $entriesByNode->get($nodeId);
                $ops[] = $this->setOp($entry->id, $rootId, $hlc, [
                    'position' => RoamPosition::at($index),
                ]);
            }

            $this->sync->push($ops);

            return true;
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

        if ($state->cloud_url && $state->cloud_workspace_id && ! $state->cloud_user_id) {
            try {
                $this->cloud->refreshCloudUserId();
                $state->refresh();
            } catch (\Throwable) {
                // Pins remain fully local while the cloud is offline.
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
        if ($localRootId === $cloudRootId) {
            return;
        }

        $localRoot = Node::query()->find($localRootId);

        if ($localRoot === null) {
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
            ->orderBy('position')
            ->orderBy('id')
            ->get();
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
        return new HlcGenerator('pins-'.Str::uuid7());
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
