<?php

namespace Tests\Support;

use App\Models\Media;
use App\Models\Node;
use App\Models\SyncState;
use App\Sync\CloudSyncService;
use App\Sync\SyncService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * Test-only cloud relay with two genuinely isolated SQLite projections and
 * local media roots. Client operations still travel through the production
 * SyncService and CloudSyncService; only the HTTP cloud is replaced.
 */
final class TwoReplicaHarness
{
    public const A = 'replica_a';

    public const B = 'replica_b';

    private string $temporaryDirectory;

    private string $originalConnection;

    private string $originalStorageRoot;

    /** @var array<int, array> */
    private array $relay = [];

    /** @var array<string, int> */
    private array $sequencesByOperation = [];

    /** @var array<int, array> */
    private array $broadcasts = [];

    /** @var array<string, string> */
    private array $cloudBlobs = [];

    public function __construct()
    {
        $this->temporaryDirectory = sys_get_temp_dir().'/yeidle-replicas-'.Str::uuid();
        $this->originalConnection = DB::getDefaultConnection();
        $this->originalStorageRoot = config('filesystems.disks.local.root');

        File::makeDirectory($this->temporaryDirectory, 0755, true);

        foreach ([self::A, self::B] as $replica) {
            $database = $this->path("{$replica}.sqlite");
            File::put($database, '');
            File::makeDirectory($this->storageRoot($replica), 0755, true);

            config(["database.connections.{$replica}" => [
                ...config('database.connections.sqlite'),
                'url' => null,
                'database' => $database,
            ]]);
            DB::purge($replica);

            Artisan::call('migrate:fresh', [
                '--database' => $replica,
                '--force' => true,
                '--no-interaction' => true,
            ]);

            $this->on($replica, function () use ($replica): void {
                SyncState::create([
                    'client_id' => "installation-{$replica}",
                    'last_server_seq' => 0,
                    'cloud_url' => 'https://cloud.test',
                    'cloud_token' => 'test-token',
                    'cloud_workspace_id' => 'workspace-1',
                    'cloud_seed_pending' => false,
                ]);
            });
        }

        $this->fakeCloud();
    }

    public function close(): void
    {
        DB::setDefaultConnection($this->originalConnection);
        config([
            'database.default' => $this->originalConnection,
            'filesystems.disks.local.root' => $this->originalStorageRoot,
        ]);
        Storage::forgetDisk('local');

        foreach ([self::A, self::B] as $replica) {
            DB::disconnect($replica);
            DB::purge($replica);
        }

        File::deleteDirectory($this->temporaryDirectory);
    }

    /** @template T */
    public function on(string $replica, callable $callback): mixed
    {
        $previousConnection = DB::getDefaultConnection();
        $previousStorageRoot = config('filesystems.disks.local.root');

        DB::setDefaultConnection($replica);
        config([
            'database.default' => $replica,
            'filesystems.disks.local.root' => $this->storageRoot($replica),
        ]);
        Storage::forgetDisk('local');

        try {
            return $callback();
        } finally {
            DB::setDefaultConnection($previousConnection);
            config([
                'database.default' => $previousConnection,
                'filesystems.disks.local.root' => $previousStorageRoot,
            ]);
            Storage::forgetDisk('local');
        }
    }

    public function push(string $replica, array $operations): void
    {
        $this->on(
            $replica,
            fn () => app(SyncService::class)->push($operations),
        );
    }

    public function exchange(string $replica): array
    {
        return $this->on(
            $replica,
            fn (): array => app(CloudSyncService::class)->exchange(),
        );
    }

    public function deliverBroadcast(string $replica, int $index): array
    {
        $event = $this->broadcasts[$index];

        return $this->on($replica, fn (): array => app(CloudSyncService::class)->ingestCommittedOps(
            $event['workspace_id'],
            $event['origin_client_id'],
            $event['previous_seq'],
            $event['latest_seq'],
            $event['ops'],
        ));
    }

    public function broadcastCount(): int
    {
        return count($this->broadcasts);
    }

    public function cursor(string $replica): int
    {
        return $this->on(
            $replica,
            fn (): int => (int) SyncState::current()->last_server_seq,
        );
    }

    public function node(string $replica, string $id): ?array
    {
        return $this->on($replica, function () use ($id): ?array {
            $node = Node::withTrashed()->find($id);

            return $node?->only([
                'id',
                'parent_id',
                'position',
                'content',
                'tiptap_content',
                'is_checked',
                'field_clocks',
                'modified_hlc',
                'purged',
            ]);
        });
    }

    public function childIds(string $replica, string $parentId): array
    {
        return $this->on(
            $replica,
            fn (): array => Node::findOrFail($parentId)->children()->pluck('id')->all(),
        );
    }

    public function media(string $replica, string $id): ?array
    {
        return $this->on(
            $replica,
            fn (): ?array => Media::find($id)?->only([
                'id',
                'filename',
                'original_name',
                'mime_type',
                'size',
            ]),
        );
    }

    public function storeCloudBlob(string $hash, string $contents): void
    {
        $this->cloudBlobs[$hash] = $contents;
    }

    public function hasLocalBlob(string $replica, string $hash): bool
    {
        return $this->on(
            $replica,
            fn (): bool => Storage::disk('local')->exists("media/{$hash}"),
        );
    }

    private function fakeCloud(): void
    {
        Http::fake(function (Request $request) {
            $url = $request->url();
            $path = parse_url($url, PHP_URL_PATH);

            if ($request->method() === 'POST'
                && $path === '/api/workspaces/workspace-1/sync/push') {
                return $this->acceptPush($request);
            }

            if ($request->method() === 'GET'
                && $path === '/api/workspaces/workspace-1/sync/pull') {
                parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
                $since = (int) ($query['since'] ?? 0);

                return Http::response([
                    'ops' => array_values(array_filter(
                        $this->relay,
                        fn (array $op): bool => $op['server_seq'] > $since,
                    )),
                    'latest_seq' => count($this->relay),
                ]);
            }

            if ($request->method() === 'GET'
                && preg_match('#^/api/workspaces/workspace-1/blobs/([0-9a-f]{64})/download-url$#', $path, $matches)) {
                return isset($this->cloudBlobs[$matches[1]])
                    ? Http::response(['url' => "https://blobs.test/{$matches[1]}"])
                    : Http::response([], 404);
            }

            if ($request->method() === 'GET'
                && parse_url($url, PHP_URL_HOST) === 'blobs.test') {
                $hash = basename($path);

                return isset($this->cloudBlobs[$hash])
                    ? Http::response($this->cloudBlobs[$hash])
                    : Http::response([], 404);
            }

            return Http::response(['message' => "Unhandled fake cloud request: {$request->method()} {$url}"], 500);
        });
    }

    private function acceptPush(Request $request): mixed
    {
        $accepted = [];
        $committed = [];
        $previousSequence = count($this->relay);

        foreach ($request['ops'] as $operation) {
            $sequence = $this->sequencesByOperation[$operation['op_id']] ?? null;

            if ($sequence === null) {
                $sequence = count($this->relay) + 1;
                $this->sequencesByOperation[$operation['op_id']] = $sequence;
                $committed[] = [...$operation, 'server_seq' => $sequence];
                $this->relay[] = [...$operation, 'server_seq' => $sequence];
            }

            $accepted[] = [
                'op_id' => $operation['op_id'],
                'server_seq' => $sequence,
            ];
        }

        if ($committed !== []) {
            $this->broadcasts[] = [
                'workspace_id' => 'workspace-1',
                'origin_client_id' => $request['client_id'],
                'previous_seq' => $previousSequence,
                'latest_seq' => count($this->relay),
                'ops' => $committed,
            ];
        }

        return Http::response(['accepted' => $accepted]);
    }

    private function path(string $path): string
    {
        return "{$this->temporaryDirectory}/{$path}";
    }

    private function storageRoot(string $replica): string
    {
        return $this->path("{$replica}-storage");
    }
}
