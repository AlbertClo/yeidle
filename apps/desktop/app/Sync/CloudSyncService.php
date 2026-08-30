<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\Node;
use App\Models\Op;
use App\Models\SyncState;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\RequestException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;
use Throwable;

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
        private CloudBlobService $blobs,
    ) {}

    /**
     * Pair this installation with a cloud workspace. Fresh cloud + local
     * data seeds the cloud; fresh local + cloud data bootstraps from its
     * snapshot; two populated operation histories merge through the normal
     * outbox push and full cursor pull.
     *
     * @return array{seeded: bool, bootstrapped: bool, pushed: int, pulled: int, ok: bool, error: ?string}
     *
     * @throws \RuntimeException on unreachable/unauthorized cloud or invalid pairing
     */
    public function connect(
        string $url,
        string $token,
        ?string $workspaceId = null,
        ?string $newWorkspaceName = null,
    ): array {
        $url = rtrim($url, '/');

        if ($newWorkspaceName !== null) {
            if ($workspaceId === null) {
                throw new \RuntimeException('A workspace ID is required to create a cloud workspace.');
            }

            $this->createCloudWorkspace($url, $token, $workspaceId, $newWorkspaceName);
        } elseif ($workspaceId === null) {
            throw new \RuntimeException('Choose which cloud workspace to connect.');
        }

        try {
            $status = Http::withToken($token)->acceptJson()
                ->connectTimeout(5)->timeout(15)
                ->get("{$url}/api/workspaces/{$workspaceId}/sync/status");
        } catch (ConnectionException) {
            throw new \RuntimeException('Could not connect to the cloud server.');
        }

        if (! $status->successful()) {
            throw new \RuntimeException("Could not reach the cloud server (HTTP {$status->status()}).");
        }

        $statusWorkspaceId = $status->json('workspace_id');
        $cloudSeq = $status->json('latest_seq');
        $cloudUserId = $status->json('user_id');

        if ($statusWorkspaceId !== $workspaceId || ! is_int($cloudSeq) || $cloudSeq < 0) {
            throw new \RuntimeException('The cloud server returned an invalid sync status.');
        }

        $localHasData = Node::withTrashed()->exists();
        $state = SyncState::current();
        $legacyPairing = $state !== null
            && $state->workspace_id === null
            && rtrim((string) $state->cloud_url, '/') === $url
            && (int) $state->last_server_seq > 0;
        $sameWorkspace = $state !== null
            && ($state->workspace_id === $workspaceId || $legacyPairing);

        if ($state?->workspace_id !== null && ! $sameWorkspace) {
            throw new \RuntimeException(
                'This installation is already connected to a different cloud workspace.'
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
        $state->workspace_id = $workspaceId;
        if (is_string($cloudUserId) && $cloudUserId !== '') {
            $state->cloud_user_id = $cloudUserId;
        }
        $state->save();

        $seeded = false;
        $bootstrapped = false;

        if ($state->cloud_seed_pending || (! $sameWorkspace && $cloudSeq === 0 && $localHasData)) {
            $state->cloud_seed_pending = true;
            $state->save();

            try {
                $this->completePendingSeed($state);
            } catch (Throwable $exception) {
                report($exception);
                $error = $this->presentError($exception, 'seed');
                $this->recordHealth($state, $error);

                throw new \RuntimeException($error);
            }

            $seeded = true;
        } elseif (! $sameWorkspace && $cloudSeq > 0 && ! $localHasData) {
            try {
                $this->bootstrapFromCloud($state);
            } catch (Throwable $exception) {
                report($exception);
                $error = $this->presentError($exception, 'bootstrap');
                $this->recordHealth($state, $error);

                throw new \RuntimeException($error);
            }

            $bootstrapped = true;
        }

        $exchange = $this->exchange();

        return [
            'seeded' => $seeded,
            'bootstrapped' => $bootstrapped,
            'pushed' => $exchange['pushed'] ?? 0,
            'pulled' => $exchange['pulled'] ?? 0,
            'ok' => $exchange['ok'],
            'error' => $exchange['error'],
        ];
    }

    /** @return list<array{id: string, name: string}> */
    public function availableWorkspaces(string $url, string $token): array
    {
        $url = rtrim($url, '/');

        try {
            $response = Http::withToken($token)->acceptJson()
                ->connectTimeout(5)->timeout(15)
                ->get("{$url}/api/workspaces");
        } catch (ConnectionException) {
            throw new \RuntimeException('Could not connect to the cloud server.');
        }

        if (! $response->successful()) {
            throw new \RuntimeException("Could not reach the cloud server (HTTP {$response->status()}).");
        }

        $workspaces = $response->json('workspaces');

        if (! is_array($workspaces)) {
            throw new \RuntimeException('The cloud server returned an invalid workspace list.');
        }

        $validated = [];

        foreach ($workspaces as $workspace) {
            if (! is_array($workspace)
                || ! is_string($workspace['id'] ?? null)
                || $workspace['id'] === ''
                || ! is_string($workspace['name'] ?? null)
                || $workspace['name'] === '') {
                throw new \RuntimeException('The cloud server returned an invalid workspace list.');
            }

            $validated[] = [
                'id' => $workspace['id'],
                'name' => $workspace['name'],
            ];
        }

        return $validated;
    }

    /**
     * One sync round. Push and pull are independent so a stuck outbox never
     * prevents this device from receiving remote changes. Failures are
     * recorded for the status endpoint and retried by the next local write,
     * realtime reconnect, or sequence-gap recovery.
     *
     * @return array{configured: bool, pushed: int, pulled: int, ok: bool, error: ?string}
     */
    public function exchange(): array
    {
        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url) {
            return [
                'configured' => false,
                'ok' => false,
                'pushed' => 0,
                'pulled' => 0,
                'error' => null,
            ];
        }

        if ($state->cloud_seed_pending) {
            try {
                $this->completePendingSeed($state);
            } catch (Throwable $exception) {
                report($exception);
                $error = $this->presentError($exception, 'seed');
                $this->recordHealth($state, $error);

                return [
                    'configured' => true,
                    'ok' => false,
                    'pushed' => 0,
                    'pulled' => 0,
                    'error' => $error,
                ];
            }
        }

        $blobError = null;

        try {
            // Blob bodies must exist before their metadata ops become visible
            // to another client. A failed upload remains durable local work.
            $this->blobs->uploadPending($state);
        } catch (Throwable $exception) {
            $blobError = $exception;
        }

        $push = $blobError === null
            ? $this->pushOutbox($state)
            : ['count' => 0, 'error' => null];
        $pull = $this->pullFromCloud($state);
        $errors = [];

        if ($blobError !== null) {
            report($blobError);
            $errors[] = $this->presentError($blobError, 'blob upload');
        }

        if ($push['error'] !== null) {
            report($push['error']);
            $errors[] = $this->presentError($push['error'], 'push');
        }

        if ($pull['error'] !== null) {
            report($pull['error']);
            $errors[] = $this->presentError($pull['error'], 'pull');
        }

        $error = $errors === [] ? null : implode(' ', $errors);
        $this->recordHealth($state, $error);

        return [
            'configured' => true,
            'ok' => $error === null,
            'pushed' => $push['count'],
            'pulled' => $pull['count'],
            'error' => $error,
        ];
    }

    /**
     * Fetch the cloud's public Reverb connection settings without exposing
     * the stored Sanctum token to the renderer.
     *
     * @return array{
     *     enabled: bool,
     *     workspace_id?: string,
     *     app_key?: string,
     *     host?: string,
     *     port?: int,
     *     scheme?: string
     * }
     */
    public function realtimeConfig(): array
    {
        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url || ! $state->workspace_id) {
            return ['enabled' => false];
        }

        $response = $this->http($state)
            ->get($this->workspaceUrl($state, 'sync/status'))
            ->throw();
        $workspaceId = $response->json('workspace_id');
        $realtime = $response->json('realtime');

        if ($workspaceId !== $state->workspace_id || ! is_array($realtime)) {
            throw new CloudSyncProtocolException(
                'Cloud realtime protocol error: workspace or connection settings are invalid.'
            );
        }

        $this->rememberCloudUserId($state, $response->json('user_id'));

        if (($realtime['enabled'] ?? false) !== true) {
            return ['enabled' => false];
        }

        $appKey = $realtime['app_key'] ?? null;
        $host = $realtime['host'] ?? null;
        $port = $realtime['port'] ?? null;
        $scheme = $realtime['scheme'] ?? null;

        if (! is_string($appKey) || $appKey === ''
            || ! is_string($host) || $host === ''
            || ! is_int($port) || $port < 1 || $port > 65535
            || ! in_array($scheme, ['http', 'https'], true)) {
            throw new CloudSyncProtocolException(
                'Cloud realtime protocol error: connection settings are invalid.'
            );
        }

        return [
            'enabled' => true,
            'workspace_id' => $workspaceId,
            'app_key' => $appKey,
            'host' => $host,
            'port' => $port,
            'scheme' => $scheme,
        ];
    }

    /**
     * Resolve and persist the authenticated cloud account identity. This is
     * intentionally separate from the device client_id: one account must
     * select the same private pin container on every installation.
     */
    public function refreshCloudUserId(): ?string
    {
        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url || ! $state->workspace_id) {
            return null;
        }

        if (is_string($state->cloud_user_id) && $state->cloud_user_id !== '') {
            return $state->cloud_user_id;
        }

        $response = $this->http($state)
            ->get($this->workspaceUrl($state, 'sync/status'))
            ->throw();

        if ($response->json('workspace_id') !== $state->workspace_id) {
            throw new CloudSyncProtocolException(
                'Cloud identity protocol error: workspace does not match this installation.'
            );
        }

        return $this->rememberCloudUserId($state, $response->json('user_id'));
    }

    private function rememberCloudUserId(SyncState $state, mixed $userId): ?string
    {
        if (! is_string($userId) || $userId === '') {
            return null;
        }

        if ($state->cloud_user_id !== $userId) {
            $state->cloud_user_id = $userId;
            $state->save();
        }

        return $userId;
    }

    /** @return array{auth: string, channel_data?: string, shared_secret?: string} */
    public function authorizeRealtime(string $socketId, string $channelName): array
    {
        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url || ! $state->workspace_id) {
            throw new \RuntimeException('Cloud sync is not configured.');
        }

        $expectedChannel = "private-workspaces.{$state->workspace_id}.sync";

        if (! hash_equals($expectedChannel, $channelName)) {
            throw new \RuntimeException('The realtime channel is not allowed.');
        }

        $response = $this->http($state)
            ->asForm()
            ->post("{$state->cloud_url}/api/broadcasting/auth", [
                'socket_id' => $socketId,
                'channel_name' => $channelName,
            ])
            ->throw();
        $authorization = $response->json();

        if (! is_array($authorization)
            || ! is_string($authorization['auth'] ?? null)
            || $authorization['auth'] === '') {
            throw new CloudSyncProtocolException(
                'Cloud realtime protocol error: authorization response is invalid.'
            );
        }

        return $authorization;
    }

    /**
     * Apply a complete committed WebSocket batch when it follows this
     * installation's cloud cursor. Missing, stale, or oversized batches
     * fall back to the normal durable pull path.
     *
     * @param  array<int, array>|null  $ops
     * @return array{applied: int, needs_pull: bool, ignored: bool}
     */
    public function ingestCommittedOps(
        string $workspaceId,
        string $originClientId,
        int $previousSeq,
        int $latestSeq,
        ?array $ops,
    ): array {
        if ($latestSeq <= $previousSeq) {
            throw new CloudSyncProtocolException(
                'Cloud realtime protocol error: sequence bounds are invalid.'
            );
        }

        if ($ops !== null && ! $this->realtimeOpsAreValid($ops, $previousSeq, $latestSeq)) {
            throw new CloudSyncProtocolException(
                'Cloud realtime protocol error: operation sequence is invalid.'
            );
        }

        return DB::transaction(function () use (
            $workspaceId,
            $originClientId,
            $previousSeq,
            $latestSeq,
            $ops,
        ) {
            $state = SyncState::query()->lockForUpdate()->first();

            if ($state === null || $state->workspace_id !== $workspaceId) {
                throw new CloudSyncProtocolException(
                    'Cloud realtime protocol error: workspace does not match this installation.'
                );
            }

            if (hash_equals((string) $state->client_id, $originClientId)) {
                return ['applied' => 0, 'needs_pull' => false, 'ignored' => true];
            }

            $cursor = (int) $state->last_server_seq;

            if ($cursor >= $latestSeq) {
                return ['applied' => 0, 'needs_pull' => false, 'ignored' => true];
            }

            if ($cursor !== $previousSeq || $ops === null) {
                return ['applied' => 0, 'needs_pull' => true, 'ignored' => false];
            }

            $applied = 0;

            foreach ($ops as $op) {
                $existing = Op::where('op_id', $op['op_id'])->first();

                if ($existing) {
                    if ($existing->server_seq === null) {
                        $existing->update(['server_seq' => $op['server_seq']]);
                    } elseif ((int) $existing->server_seq !== $op['server_seq']) {
                        throw new CloudSyncProtocolException(
                            'Cloud realtime protocol error: operation sequence conflicts with the local log.'
                        );
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
                    $applied++;
                }
            }

            $completedAt = now();
            $state->last_server_seq = $latestSeq;
            $state->last_sync_attempt_at = $completedAt;
            $state->last_sync_success_at = $completedAt;
            $state->last_sync_error = null;
            $state->save();

            return ['applied' => $applied, 'needs_pull' => false, 'ignored' => false];
        });
    }

    private function http(SyncState $state): PendingRequest
    {
        return Http::withToken($state->cloud_token)->acceptJson()
            ->connectTimeout(5)->timeout(30);
    }

    /** @param  array<int, array>  $ops */
    private function realtimeOpsAreValid(array $ops, int $previousSeq, int $latestSeq): bool
    {
        if ($ops === []) {
            return false;
        }

        $lastSeq = $previousSeq;

        foreach ($ops as $op) {
            $serverSeq = $op['server_seq'] ?? null;

            if (! is_int($serverSeq) || $serverSeq <= $lastSeq || $serverSeq > $latestSeq) {
                return false;
            }

            $lastSeq = $serverSeq;
        }

        return $lastSeq === $latestSeq;
    }

    /** @return array{count: int, error: ?Throwable} */
    private function pushOutbox(SyncState $state): array
    {
        $total = 0;

        try {
            while (true) {
                $batch = Op::whereNull('server_seq')->orderBy('id')->limit(self::BATCH)->get();

                if ($batch->isEmpty()) {
                    return ['count' => $total, 'error' => null];
                }

                $response = $this->http($state)->post($this->workspaceUrl($state, 'sync/push'), [
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

                $acknowledgements = $this->recordAcknowledgements(
                    $batch,
                    $response->json('accepted'),
                );
                $total += $acknowledgements['count'];

                if ($acknowledgements['error'] !== null) {
                    return ['count' => $total, 'error' => $acknowledgements['error']];
                }
            }
        } catch (Throwable $exception) {
            return ['count' => $total, 'error' => $exception];
        }
    }

    /**
     * Record only valid acknowledgements for the submitted batch. A partial
     * or malformed response makes no further push progress during this
     * exchange, but valid acknowledgements remain durable for the retry.
     *
     * @param  Collection<int, Op>  $batch
     * @return array{count: int, error: ?CloudSyncProtocolException}
     */
    private function recordAcknowledgements(Collection $batch, mixed $accepted): array
    {
        $submittedIds = $batch->pluck('op_id')->all();
        $acknowledgements = $this->validateAcknowledgements($submittedIds, $accepted, 'push');
        $valid = $acknowledgements['valid'];

        if ($valid !== []) {
            DB::transaction(function () use ($valid) {
                foreach ($valid as $opId => $serverSeq) {
                    Op::where('op_id', $opId)
                        ->whereNull('server_seq')
                        ->update(['server_seq' => $serverSeq]);
                }
            });
        }

        return [
            'count' => count($valid),
            'error' => $acknowledgements['error'],
        ];
    }

    /**
     * @param  array<int, string>  $submittedIds
     * @return array{valid: array<string, int>, error: ?CloudSyncProtocolException}
     */
    private function validateAcknowledgements(array $submittedIds, mixed $accepted, string $phase): array
    {
        $submitted = array_fill_keys($submittedIds, true);
        $valid = [];
        $hasInvalidEntries = false;

        if (! is_array($accepted)) {
            $accepted = [];
            $hasInvalidEntries = true;
        }

        foreach ($accepted as $acknowledgement) {
            if (! is_array($acknowledgement)) {
                $hasInvalidEntries = true;

                continue;
            }

            $opId = $acknowledgement['op_id'] ?? null;
            $serverSeq = $acknowledgement['server_seq'] ?? null;

            if (! is_string($opId)
                || ! isset($submitted[$opId])
                || ! is_int($serverSeq)
                || $serverSeq < 1
                || isset($valid[$opId])) {
                $hasInvalidEntries = true;

                continue;
            }

            $valid[$opId] = $serverSeq;
        }

        $acknowledged = count($valid);
        $submittedCount = count($submittedIds);

        if ($hasInvalidEntries || $acknowledged !== $submittedCount) {
            $detail = $hasInvalidEntries
                ? ' The response also contained invalid acknowledgement entries.'
                : '';

            return [
                'valid' => $valid,
                'error' => new CloudSyncProtocolException(
                    "Cloud {$phase} protocol error: acknowledged {$acknowledged} of {$submittedCount} submitted operations.{$detail}"
                ),
            ];
        }

        return ['valid' => $valid, 'error' => null];
    }

    /** @return array{count: int, error: ?Throwable} */
    private function pullFromCloud(SyncState $state): array
    {
        $total = 0;

        try {
            while (true) {
                $response = $this->http($state)->get($this->workspaceUrl($state, 'sync/pull'), [
                    'since' => (int) $state->last_server_seq,
                ]);

                $response->throw();

                $ops = $response->json('ops');
                $latest = $response->json('latest_seq');

                if (! is_array($ops) || ! is_int($latest) || $latest < 0) {
                    throw new CloudSyncProtocolException(
                        'Cloud pull protocol error: expected an operation list and a valid latest sequence.'
                    );
                }

                if ($ops === []) {
                    DB::transaction(function () use ($state, $latest) {
                        $lockedState = SyncState::query()->lockForUpdate()->findOrFail($state->id);

                        if ($latest > (int) $lockedState->last_server_seq) {
                            $lockedState->last_server_seq = $latest;
                            $lockedState->save();
                        }
                    });

                    $state->refresh();

                    return ['count' => $total, 'error' => null];
                }

                $pulled = 0;

                DB::transaction(function () use ($ops, $state, &$pulled) {
                    $lockedState = SyncState::query()->lockForUpdate()->findOrFail($state->id);

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
                            $pulled++;
                        }

                        $lockedState->last_server_seq = max(
                            (int) $lockedState->last_server_seq,
                            $op['server_seq'],
                        );
                    }

                    $lockedState->save();
                });

                $state->refresh();
                $total += $pulled;
            }
        } catch (Throwable $exception) {
            return ['count' => $total, 'error' => $exception];
        }
    }

    private function presentError(Throwable $exception, string $phase): string
    {
        if ($exception instanceof CloudSyncProtocolException) {
            return $exception->getMessage();
        }

        if ($exception instanceof ConnectionException) {
            return "Cloud {$phase} failed: could not connect to the cloud server.";
        }

        if ($exception instanceof RequestException) {
            return "Cloud {$phase} failed (HTTP {$exception->response->status()}).";
        }

        return "Cloud {$phase} failed.";
    }

    private function recordHealth(SyncState $state, ?string $error): void
    {
        $completedAt = now();

        $state->last_sync_attempt_at = $completedAt;
        $state->last_sync_error = $error;

        if ($error === null) {
            $state->last_sync_success_at = $completedAt;
        }

        $state->save();
    }

    private function completePendingSeed(SyncState $state): void
    {
        $this->blobs->uploadPending($state);
        $this->seedCloud($state);

        $state->cloud_seed_pending = false;
        $state->save();
    }

    /**
     * First pairing with an empty cloud: mint ops representing the current
     * local state and push them straight to the cloud (not the local log —
     * the pull brings them back and reconciles both logs identically).
     */
    private function seedCloud(SyncState $state): void
    {
        $clock = new HlcGenerator('seed-'.$state->client_id);
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
                'op_id' => $this->seedOpId($state, 'node.set', $node->id),
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
                        'page_type' => $node->page_type,
                        'daily_note_date' => $node->daily_note_date,
                    ],
                ],
            ];

            if ($node->trashed()) {
                $ops[] = [
                    'op_id' => $this->seedOpId($state, 'node.delete', $node->id),
                    'client_id' => $clock->clientId,
                    'hlc' => $clock->now(),
                    'type' => 'node.delete',
                    'payload' => ['v' => 1, 'id' => $node->id, 'page_id' => $pageId],
                ];
            }
        }

        foreach (Media::all() as $media) {
            $ops[] = [
                'op_id' => $this->seedOpId($state, 'media.create', $media->id),
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
            $response = $this->http($state)->post($this->workspaceUrl($state, 'sync/push'), [
                'client_id' => $state->client_id,
                'ops' => $chunk,
            ]);

            $response->throw();

            $acknowledgements = $this->validateAcknowledgements(
                array_column($chunk, 'op_id'),
                $response->json('accepted'),
                'seed',
            );

            if ($acknowledgements['error'] !== null) {
                throw $acknowledgements['error'];
            }
        }
    }

    private function seedOpId(SyncState $state, string $type, string $entityId): string
    {
        return Uuid::uuid5($state->client_id, "{$type}:{$entityId}")->toString();
    }

    /**
     * First pairing of a fresh install with an existing cloud workspace:
     * install the snapshot directly (the sanctioned exception to
     * "only op-apply writes projections") and set the cursor.
     */
    private function bootstrapFromCloud(SyncState $state): void
    {
        $snapshot = $this->http($state)
            ->get($this->workspaceUrl($state, 'sync/bootstrap'))
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
                        'page_type' => $n['page_type'] ?? null,
                        'daily_note_date' => $n['daily_note_date'] ?? null,
                        'field_clocks' => isset($n['field_clocks']) ? json_encode($n['field_clocks']) : null,
                        'purged' => $n['purged'] ?? false,
                        'modified_hlc' => $this->snapshotModifiedHlc($n),
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

    /** @param  array<string, mixed>  $node */
    private function snapshotModifiedHlc(array $node): string
    {
        if (is_string($node['modified_hlc'] ?? null)) {
            return $node['modified_hlc'];
        }

        $clocks = $node['field_clocks'] ?? [];
        $hlcs = is_array($clocks)
            ? array_values(array_filter($clocks, is_string(...)))
            : [];

        return $hlcs === [] ? HlcGenerator::EPOCH : max($hlcs);
    }

    /** @return array{id: string, name: string} */
    private function createCloudWorkspace(
        string $url,
        string $token,
        string $workspaceId,
        string $name,
    ): array {
        try {
            $response = Http::withToken($token)->acceptJson()
                ->connectTimeout(5)->timeout(15)
                ->post(rtrim($url, '/').'/api/workspaces', [
                    'id' => $workspaceId,
                    'name' => $name,
                ]);
        } catch (ConnectionException) {
            throw new \RuntimeException('Could not connect to the cloud server.');
        }

        if (! $response->successful()) {
            throw new \RuntimeException("Could not create the cloud workspace (HTTP {$response->status()}).");
        }

        $workspace = $response->json('workspace');

        if (! is_array($workspace)
            || ! is_string($workspace['id'] ?? null)
            || $workspace['id'] !== $workspaceId
            || ! is_string($workspace['name'] ?? null)
            || $workspace['name'] === '') {
            throw new \RuntimeException('The cloud server returned an invalid workspace.');
        }

        return ['id' => $workspace['id'], 'name' => $workspace['name']];
    }

    private function workspaceUrl(SyncState $state, string $path): string
    {
        if (! $state->cloud_url || ! $state->workspace_id) {
            throw new \RuntimeException('Cloud sync is not configured.');
        }

        return "{$state->cloud_url}/api/workspaces/{$state->workspace_id}/{$path}";
    }
}
