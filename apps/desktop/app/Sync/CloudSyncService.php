<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\Node;
use App\Models\Op;
use App\Models\SyncState;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/**
 * The desktop's cloud client (sync design §6, Phase 1). Local ops whose
 * server_seq is null form the cloud outbox; pulled cloud ops are appended
 * to the local log and applied, which hands them to the open editor
 * through the existing local pull loop — the cloud is just a second
 * upstream for the same machinery.
 */
class CloudSyncService
{
    private const BATCH = 200;

    public function __construct(
        private OpApplier $applier,
    ) {}

    /**
     * Pair this installation with a cloud workspace. Fresh cloud + local
     * data seeds the cloud; fresh local + cloud data bootstraps from its
     * snapshot; both non-empty on first pairing is refused.
     *
     * @return array{seeded: bool, bootstrapped: bool, pushed: int, pulled: int}
     *
     * @throws \RuntimeException on unreachable/unauthorized cloud or refused pairing
     */
    public function connect(string $url, string $token): array
    {
        $url = rtrim($url, '/');

        $status = Http::withToken($token)->acceptJson()
            ->connectTimeout(5)->timeout(15)
            ->get("{$url}/api/sync/status");

        if (! $status->successful()) {
            throw new \RuntimeException("Could not reach the cloud server (HTTP {$status->status()}).");
        }

        $cloudSeq = (int) $status->json('latest_seq');
        $localHasData = Node::withTrashed()->exists();
        $state = SyncState::current();
        $alreadyPaired = $state !== null && (int) $state->last_server_seq > 0;

        if (! $alreadyPaired && $cloudSeq > 0 && $localHasData) {
            throw new \RuntimeException(
                'Both this device and the cloud workspace already contain data. '
                .'Connect a fresh install, or use an empty cloud workspace.'
            );
        }

        if ($state === null) {
            $state = SyncState::create([
                'client_id' => (string) Str::uuid7(),
                'last_server_seq' => 0,
            ]);
        }

        $state->cloud_url = $url;
        $state->cloud_token = $token;
        $state->save();

        $seeded = false;
        $bootstrapped = false;

        if (! $alreadyPaired && $cloudSeq === 0 && $localHasData) {
            $this->seedCloud($state);
            $seeded = true;
        } elseif (! $alreadyPaired && $cloudSeq > 0 && ! $localHasData) {
            $this->bootstrapFromCloud($state);
            $bootstrapped = true;
        }

        $exchange = $this->exchange();

        return [
            'seeded' => $seeded,
            'bootstrapped' => $bootstrapped,
            'pushed' => $exchange['pushed'] ?? 0,
            'pulled' => $exchange['pulled'] ?? 0,
        ];
    }

    /**
     * One sync round: push the outbox, then pull. Silent on transport
     * failure — the next tick retries.
     *
     * @return array{configured: bool, pushed?: int, pulled?: int, ok?: bool}
     */
    public function exchange(): array
    {
        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url) {
            return ['configured' => false];
        }

        try {
            $pushed = $this->pushOutbox($state);
            $pulled = $this->pullFromCloud($state);

            return ['configured' => true, 'ok' => true, 'pushed' => $pushed, 'pulled' => $pulled];
        } catch (\Throwable) {
            return ['configured' => true, 'ok' => false, 'pushed' => 0, 'pulled' => 0];
        }
    }

    private function http(SyncState $state): PendingRequest
    {
        return Http::withToken($state->cloud_token)->acceptJson()
            ->connectTimeout(5)->timeout(30);
    }

    private function pushOutbox(SyncState $state): int
    {
        $total = 0;

        while (true) {
            $batch = Op::whereNull('server_seq')->orderBy('id')->limit(self::BATCH)->get();

            if ($batch->isEmpty()) {
                return $total;
            }

            $response = $this->http($state)->post("{$state->cloud_url}/api/sync/push", [
                'client_id' => $state->client_id,
                'ops' => $batch->map(fn (Op $op) => [
                    'op_id' => $op->op_id,
                    'client_id' => $op->client_id,
                    'hlc' => $op->hlc,
                    'type' => $op->type,
                    'payload' => $op->payload,
                ])->all(),
            ]);

            $response->throw();

            foreach ($response->json('accepted', []) as $ack) {
                Op::where('op_id', $ack['op_id'])->update(['server_seq' => $ack['server_seq']]);
            }

            $total += $batch->count();
        }
    }

    private function pullFromCloud(SyncState $state): int
    {
        $total = 0;

        while (true) {
            $response = $this->http($state)->get("{$state->cloud_url}/api/sync/pull", [
                'since' => (int) $state->last_server_seq,
            ]);

            $response->throw();

            $ops = $response->json('ops', []);
            $latest = (int) $response->json('latest_seq');

            if ($ops === []) {
                if ($latest > (int) $state->last_server_seq) {
                    $state->last_server_seq = $latest;
                    $state->save();
                }

                return $total;
            }

            DB::transaction(function () use ($ops, $state, &$total) {
                foreach ($ops as $op) {
                    $existing = Op::where('op_id', $op['op_id'])->first();

                    if ($existing) {
                        // Our own op coming back — record its cloud position
                        if ($existing->server_seq === null) {
                            $existing->update(['server_seq' => $op['server_seq']]);
                        }
                    } else {
                        Op::create([
                            'op_id' => $op['op_id'],
                            'server_seq' => $op['server_seq'],
                            'client_id' => $op['client_id'],
                            'hlc' => $op['hlc'],
                            'type' => $op['type'],
                            'payload' => $op['payload'],
                            'created_at' => now(),
                        ]);

                        $this->applier->apply($op);
                        $total++;
                    }

                    $state->last_server_seq = $op['server_seq'];
                }

                $state->save();
            });
        }
    }

    /**
     * First pairing with an empty cloud: mint ops representing the current
     * local state and push them straight to the cloud (not the local log —
     * the pull brings them back and reconciles both logs identically).
     */
    private function seedCloud(SyncState $state): void
    {
        $clock = new HlcGenerator('seed-'.Str::uuid7());
        $nodes = Node::withTrashed()->where('purged', false)->get();

        $pageIdOf = function (Node $node) use ($nodes) {
            $current = $node;
            $guard = 0;

            while ($current->parent_id !== null && $guard++ < 100) {
                $parent = $nodes->firstWhere('id', $current->parent_id);

                if (! $parent) {
                    break;
                }

                $current = $parent;
            }

            return $current->id;
        };

        $ops = [];

        foreach ($nodes as $node) {
            $pageId = $pageIdOf($node);

            $ops[] = [
                'op_id' => (string) Str::uuid7(),
                'client_id' => $clock->clientId,
                'hlc' => $clock->now(),
                'type' => 'node.set',
                'payload' => [
                    'v' => 1,
                    'id' => $node->id,
                    'page_id' => $pageId,
                    'fields' => [
                        'parent_id' => $node->parent_id,
                        'position' => $node->position,
                        'content' => $node->content,
                        'tiptap_content' => $node->tiptap_content,
                        'is_checked' => $node->is_checked,
                    ],
                ],
            ];

            if ($node->trashed()) {
                $ops[] = [
                    'op_id' => (string) Str::uuid7(),
                    'client_id' => $clock->clientId,
                    'hlc' => $clock->now(),
                    'type' => 'node.delete',
                    'payload' => ['v' => 1, 'id' => $node->id, 'page_id' => $pageId],
                ];
            }
        }

        foreach (Media::all() as $media) {
            $ops[] = [
                'op_id' => (string) Str::uuid7(),
                'client_id' => $clock->clientId,
                'hlc' => $clock->now(),
                'type' => 'media.create',
                'payload' => [
                    'v' => 1,
                    'id' => $media->id,
                    'hash' => $media->filename,
                    'original_name' => $media->original_name,
                    'mime_type' => $media->mime_type,
                    'size' => $media->size,
                ],
            ];
        }

        foreach (array_chunk($ops, self::BATCH) as $chunk) {
            $this->http($state)->post("{$state->cloud_url}/api/sync/push", [
                'client_id' => $state->client_id,
                'ops' => $chunk,
            ])->throw();
        }
    }

    /**
     * First pairing of a fresh install with an existing cloud workspace:
     * install the snapshot directly (the sanctioned exception to
     * "only op-apply writes projections") and set the cursor.
     */
    private function bootstrapFromCloud(SyncState $state): void
    {
        $snapshot = $this->http($state)
            ->get("{$state->cloud_url}/api/sync/bootstrap")
            ->throw()
            ->json();

        DB::transaction(function () use ($snapshot, $state) {
            $nodes = collect($snapshot['nodes'] ?? []);

            // Parents before children so the self-referential FK holds
            $inserted = [];
            $remaining = $nodes;

            while ($remaining->isNotEmpty()) {
                [$ready, $remaining] = $remaining->partition(
                    fn ($n) => $n['parent_id'] === null || isset($inserted[$n['parent_id']])
                );

                if ($ready->isEmpty()) {
                    // Orphaned parents (e.g. purged upstream): attach at top
                    $ready = $remaining->map(function ($n) {
                        $n['parent_id'] = null;

                        return $n;
                    });
                    $remaining = collect();
                }

                foreach ($ready as $n) {
                    Node::query()->insert([
                        'id' => $n['id'],
                        'parent_id' => $n['parent_id'],
                        'position' => $n['position'],
                        'content' => $n['content'] ?? '',
                        'tiptap_content' => isset($n['tiptap_content']) ? json_encode($n['tiptap_content']) : null,
                        'is_checked' => $n['is_checked'],
                        'field_clocks' => isset($n['field_clocks']) ? json_encode($n['field_clocks']) : null,
                        'purged' => $n['purged'] ?? false,
                        'deleted_at' => $n['deleted_at'],
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]);
                    $inserted[$n['id']] = true;
                }
            }

            foreach ($snapshot['media'] ?? [] as $m) {
                Media::query()->insert([
                    'id' => $m['id'],
                    'filename' => $m['filename'],
                    'original_name' => $m['original_name'],
                    'mime_type' => $m['mime_type'],
                    'size' => $m['size'],
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            }

            $state->last_server_seq = (int) ($snapshot['latest_seq'] ?? 0);
            $state->save();
        });
    }
}
