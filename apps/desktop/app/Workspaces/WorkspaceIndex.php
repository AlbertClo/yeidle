<?php

namespace App\Workspaces;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use JsonException;
use RuntimeException;
use Throwable;

final class WorkspaceIndex
{
    private const VERSION = 3;

    private string $indexPath;

    private readonly string $baseStoragePath;

    private bool $recoveredMissingDatabase = false;

    public function __construct(
        private readonly string $baseDatabasePath,
        ?string $baseStoragePath = null,
    ) {
        $this->indexPath = dirname($baseDatabasePath).DIRECTORY_SEPARATOR.'workspaces.json';
        $this->baseStoragePath = $baseStoragePath ?? storage_path('app/private');
    }

    /**
     * @return array{active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>}
     */
    public function state(): array
    {
        $state = $this->read();

        return [
            'active_workspace_id' => $state['active_workspace_id'],
            'workspaces' => $state['workspaces'],
        ];
    }

    /** @return list<array{id: string, name: string, database: string}> */
    public function all(): array
    {
        return $this->read()['workspaces'];
    }

    /** @return array{id: string, name: string, database: string} */
    public function active(): array
    {
        $state = $this->read();

        return $this->findInState($state, $state['active_workspace_id']);
    }

    /** @return array{id: string, name: string, database: string} */
    public function find(string $workspaceId): array
    {
        return $this->findInState($this->read(), $workspaceId);
    }

    /** @return array{id: string, name: string, database: string} */
    public function create(string $name, ?string $workspaceId = null): array
    {
        $name = trim($name);

        if ($name === '') {
            throw new RuntimeException('Workspace name cannot be empty.');
        }

        $workspaceId ??= (string) Str::uuid7();

        if (! Str::isUuid($workspaceId)) {
            throw new RuntimeException('Workspace ID must be a UUID.');
        }

        $state = $this->read();

        if (collect($state['workspaces'])->contains('id', $workspaceId)) {
            throw new RuntimeException("Workspace [{$workspaceId}] already exists.");
        }

        $workspace = $this->createWorkspaceRecord($workspaceId, $name);
        $state['workspaces'][] = $workspace;
        $this->write($state);

        return $workspace;
    }

    /** @return array{id: string, name: string, database: string} */
    public function rename(string $workspaceId, string $name): array
    {
        $name = trim($name);

        if ($name === '') {
            throw new RuntimeException('Workspace name cannot be empty.');
        }

        $state = $this->read();
        $index = collect($state['workspaces'])->search(
            fn (array $workspace): bool => $workspace['id'] === $workspaceId,
        );

        if ($index === false) {
            throw new RuntimeException("Local workspace [{$workspaceId}] was not found.");
        }

        $state['workspaces'][$index]['name'] = $name;
        $this->write($state);

        return $state['workspaces'][$index];
    }

    public function delete(string $workspaceId): array
    {
        $state = $this->read();
        $workspace = $this->findInState($state, $workspaceId);
        $state['workspaces'] = array_values(array_filter(
            $state['workspaces'],
            fn (array $candidate): bool => $candidate['id'] !== $workspaceId,
        ));

        if ($state['workspaces'] === []) {
            $replacementId = (string) Str::uuid7();
            $state['workspaces'][] = $this->createWorkspaceRecord(
                $replacementId,
                'Personal',
            );
        }

        if ($state['active_workspace_id'] === $workspaceId) {
            $state['active_workspace_id'] = $state['workspaces'][0]['id'];
        }

        $this->write($state);
        $this->deleteWorkspaceFiles($workspace);

        return $this->state();
    }

    /**
     * Make every cloud workspace visible locally without downloading its
     * contents. A workspace has one UUID everywhere, so catalog entries are
     * matched only by ID and never by name or whichever workspace is active.
     *
     * @param  list<array{id: string, name: string, role?: string, owned?: bool}>  $cloudWorkspaces
     */
    public function syncCloudCatalog(string $accountId, array $cloudWorkspaces): array
    {
        $state = $this->read();

        foreach ($cloudWorkspaces as $cloudWorkspace) {
            if (! is_string($cloudWorkspace['id'] ?? null)
                || ! Str::isUuid($cloudWorkspace['id'])
                || ! is_string($cloudWorkspace['name'] ?? null)
                || trim($cloudWorkspace['name']) === '') {
                throw new RuntimeException('The cloud workspace catalog is invalid.');
            }

            $index = collect($state['workspaces'])->search(
                fn (array $workspace): bool => $workspace['id'] === $cloudWorkspace['id'],
            );

            if ($index === false) {
                $state['workspaces'][] = $this->createWorkspaceRecord(
                    $cloudWorkspace['id'],
                    trim($cloudWorkspace['name']),
                );
                $index = array_key_last($state['workspaces']);
            }

            $state['workspaces'][$index]['name'] = trim($cloudWorkspace['name']);
            $state['workspaces'][$index]['cloud_account_id'] = $accountId;
            $state['workspaces'][$index]['cloud_status'] = $state['workspaces'][$index]['cloud_status'] === 'ready'
                ? 'ready'
                : 'available';
            $state['workspaces'][$index]['cloud_role'] = $cloudWorkspace['role'] ?? 'member';
            $state['workspaces'][$index]['cloud_owned'] = $cloudWorkspace['owned'] ?? false;
            $state['workspaces'][$index]['cloud_error'] = null;
        }

        $this->write($state);

        return $this->state();
    }

    public function markCloudStatus(string $workspaceId, string $status, ?string $error = null): void
    {
        if (! in_array($status, ['available', 'syncing', 'ready', 'error'], true)) {
            throw new RuntimeException('The cloud workspace status is invalid.');
        }

        $state = $this->read();
        $index = collect($state['workspaces'])->search(
            fn (array $workspace): bool => $workspace['id'] === $workspaceId,
        );

        if ($index === false) {
            throw new RuntimeException("Local workspace [{$workspaceId}] was not found.");
        }

        $state['workspaces'][$index]['cloud_status'] = $status;
        $state['workspaces'][$index]['cloud_error'] = $error;
        $this->write($state);
    }

    /** @return array{id: string, name: string, database: string} */
    public function activate(string $workspaceId): array
    {
        $state = $this->read();
        $workspace = $this->findInState($state, $workspaceId);
        $state['active_workspace_id'] = $workspaceId;
        $this->write($state);

        return $workspace;
    }

    public function configureActiveConnection(?string $workspaceId = null): void
    {
        $workspace = $workspaceId === null ? $this->active() : $this->find($workspaceId);
        $connection = config('database.default');

        if (! is_string($connection) || $connection === '') {
            throw new RuntimeException('The active database connection is not configured.');
        }

        $databasePath = $this->databasePath($workspace);

        if ($this->ensureDatabaseExists($databasePath)) {
            $this->recoveredMissingDatabase = true;
        }

        config(["database.connections.{$connection}.database" => $databasePath]);
        $this->connect($connection);

        if ($this->needsMigration($connection)) {
            $this->migrate($databasePath);
            $this->connect($connection);
        }

        $storagePath = $this->storagePath($workspace);

        if (! is_dir($storagePath) && ! mkdir($storagePath, 0700, true) && ! is_dir($storagePath)) {
            throw new RuntimeException('The workspace storage directory could not be created.');
        }

        config(['filesystems.disks.local.root' => $storagePath]);
        Storage::forgetDisk('local');
    }

    private function connect(string $connection): void
    {
        DB::purge($connection);
        DB::connection($connection)->statement('PRAGMA journal_mode=WAL;');
        DB::connection($connection)->statement('PRAGMA busy_timeout=5000;');
    }

    private function ensureDatabaseExists(string $databasePath): bool
    {
        if (is_file($databasePath)) {
            return false;
        }

        $directory = dirname($databasePath);

        if (! is_dir($directory) && ! mkdir($directory, 0700, true) && ! is_dir($directory)) {
            throw new RuntimeException('The workspace database directory could not be created.');
        }

        if (! touch($databasePath)) {
            throw new RuntimeException('The workspace database could not be recreated.');
        }

        return true;
    }

    private function needsMigration(string $connection): bool
    {
        $files = glob(database_path('migrations/*.php')) ?: [];
        sort($files, SORT_STRING);
        $database = DB::connection($connection);

        if ($files === []) {
            return false;
        }

        if (! $database->getSchemaBuilder()->hasTable('migrations')) {
            return true;
        }

        $applied = $database->table('migrations')
            ->pluck('migration')
            ->flip();

        return collect($files)->contains(
            fn (string $file): bool => ! $applied->has(pathinfo($file, PATHINFO_FILENAME))
        );
    }

    /** @param array{id: string, name: string, database: string} $workspace */
    public function databasePath(array $workspace): string
    {
        return $this->resolveDatabasePath($workspace['database']);
    }

    /** @param array{id: string, name: string, database: string} $workspace */
    public function storagePath(array $workspace): string
    {
        if ($workspace['database'] === basename($this->baseDatabasePath)) {
            return $this->baseStoragePath;
        }

        return dirname($this->databasePath($workspace))
            .DIRECTORY_SEPARATOR.$workspace['id']
            .DIRECTORY_SEPARATOR.'storage';
    }

    public function appDataDirectory(): string
    {
        return dirname($this->baseDatabasePath);
    }

    public function recoveredMissingDatabase(): bool
    {
        return $this->recoveredMissingDatabase;
    }

    /**
     * @return array{version: int, active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>}
     */
    private function read(): array
    {
        if (! is_file($this->indexPath)) {
            $this->write($this->initialState());
        }

        try {
            $state = json_decode((string) file_get_contents($this->indexPath), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new RuntimeException('The local workspace index is not valid JSON.', previous: $exception);
        }

        if (! is_array($state)
            || ! in_array($state['version'] ?? null, [1, 2, self::VERSION], true)
            || ! is_string($state['active_workspace_id'] ?? null)
            || ! is_array($state['workspaces'] ?? null)) {
            throw new RuntimeException('The local workspace index is invalid.');
        }

        if ($state['version'] === 1) {
            $state['version'] = 2;
            $state['workspaces'] = array_map(
                fn (array $workspace): array => [
                    ...$workspace,
                    'cloud_workspace_id' => null,
                    'cloud_account_id' => null,
                    'cloud_status' => 'local',
                    'cloud_role' => null,
                    'cloud_owned' => null,
                    'cloud_error' => null,
                ],
                $state['workspaces'],
            );
        }

        if ($state['version'] === 2) {
            $state = $this->upgradeUniversalWorkspaceIds($state);
            $this->write($state);
        }

        foreach ($state['workspaces'] as $workspace) {
            if (! is_array($workspace)
                || ! is_string($workspace['id'] ?? null)
                || ! is_string($workspace['name'] ?? null)
                || ! is_string($workspace['database'] ?? null)
                || ($workspace['cloud_account_id'] !== null && ! is_string($workspace['cloud_account_id']))
                || ! in_array($workspace['cloud_status'] ?? null, ['local', 'available', 'syncing', 'ready', 'error'], true)
                || ($workspace['cloud_role'] !== null && ! is_string($workspace['cloud_role']))
                || ($workspace['cloud_owned'] !== null && ! is_bool($workspace['cloud_owned']))
                || ($workspace['cloud_error'] !== null && ! is_string($workspace['cloud_error']))
                || ! Str::isUuid($workspace['id'])
                || trim($workspace['name']) === ''
                || ! $this->isManagedDatabase($workspace['id'], $workspace['database'])) {
                throw new RuntimeException('The local workspace index contains an invalid workspace.');
            }
        }

        /** @var array{version: int, active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>} $state */
        $this->findInState($state, $state['active_workspace_id']);

        return $state;
    }

    /**
     * @return array{version: int, active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>}
     */
    private function initialState(): array
    {
        $workspaceId = (string) Str::uuid7();

        return [
            'version' => self::VERSION,
            'active_workspace_id' => $workspaceId,
            'workspaces' => [[
                'id' => $workspaceId,
                'name' => 'Personal',
                'database' => basename($this->baseDatabasePath),
                'cloud_account_id' => null,
                'cloud_status' => 'local',
                'cloud_role' => null,
                'cloud_owned' => null,
                'cloud_error' => null,
            ]],
        ];
    }

    /**
     * @param  array{version: int, active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>}  $state
     */
    private function write(array $state): void
    {
        if (! is_dir(dirname($this->indexPath)) && ! mkdir(dirname($this->indexPath), 0700, true) && ! is_dir(dirname($this->indexPath))) {
            throw new RuntimeException('The workspace index directory could not be created.');
        }

        try {
            $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).PHP_EOL;
        } catch (JsonException $exception) {
            throw new RuntimeException('The workspace index could not be encoded.', previous: $exception);
        }

        $temporaryPath = $this->indexPath.'.tmp-'.bin2hex(random_bytes(6));

        if (file_put_contents($temporaryPath, $json, LOCK_EX) === false
            || ! rename($temporaryPath, $this->indexPath)) {
            @unlink($temporaryPath);

            throw new RuntimeException('The workspace index could not be saved.');
        }

        @chmod($this->indexPath, 0600);
    }

    /**
     * @param  array{version: int, active_workspace_id: string, workspaces: list<array{id: string, name: string, database: string}>}  $state
     * @return array{id: string, name: string, database: string}
     */
    private function findInState(array $state, string $workspaceId): array
    {
        foreach ($state['workspaces'] as $workspace) {
            if ($workspace['id'] === $workspaceId) {
                return $workspace;
            }
        }

        throw new RuntimeException("Local workspace [{$workspaceId}] was not found.");
    }

    private function resolveDatabasePath(string $database): string
    {
        $normalizedDatabase = str_replace('\\', '/', $database);

        if ($normalizedDatabase === ''
            || str_starts_with($normalizedDatabase, '/')
            || preg_match('/^[A-Za-z]:\//', $normalizedDatabase) === 1
            || in_array('..', explode('/', $normalizedDatabase), true)) {
            throw new RuntimeException('The workspace database path is invalid.');
        }

        $baseDirectory = realpath(dirname($this->baseDatabasePath));

        if ($baseDirectory === false) {
            throw new RuntimeException('The application database directory does not exist.');
        }

        $path = $baseDirectory.DIRECTORY_SEPARATOR.$database;
        $directory = realpath(dirname($path));

        if ($directory !== false && $directory !== $baseDirectory && ! str_starts_with($directory, $baseDirectory.DIRECTORY_SEPARATOR)) {
            throw new RuntimeException('The workspace database path is outside the application data directory.');
        }

        return $path;
    }

    private function isManagedDatabase(string $workspaceId, string $database): bool
    {
        return $database === basename($this->baseDatabasePath)
            || $database === 'workspaces'.DIRECTORY_SEPARATOR.$workspaceId.'.sqlite';
    }

    /**
     * @return array{id: string, name: string, database: string, cloud_account_id: null, cloud_status: string, cloud_role: null, cloud_owned: null, cloud_error: null}
     */
    private function createWorkspaceRecord(string $workspaceId, string $name): array
    {
        $relativeDatabasePath = 'workspaces'.DIRECTORY_SEPARATOR.$workspaceId.'.sqlite';
        $databasePath = $this->resolveDatabasePath($relativeDatabasePath);

        if (! is_dir(dirname($databasePath)) && ! mkdir(dirname($databasePath), 0700, true) && ! is_dir(dirname($databasePath))) {
            throw new RuntimeException('The workspace directory could not be created.');
        }

        if (! touch($databasePath)) {
            throw new RuntimeException('The workspace database could not be created.');
        }

        try {
            $this->migrate($databasePath);
        } catch (Throwable $exception) {
            @unlink($databasePath);
            @unlink($databasePath.'-shm');
            @unlink($databasePath.'-wal');

            throw $exception;
        }

        return [
            'id' => $workspaceId,
            'name' => $name,
            'database' => $relativeDatabasePath,
            'cloud_account_id' => null,
            'cloud_status' => 'local',
            'cloud_role' => null,
            'cloud_owned' => null,
            'cloud_error' => null,
        ];
    }

    /** @param array{version: int, active_workspace_id: string, workspaces: list<array>} $state */
    private function upgradeUniversalWorkspaceIds(array $state): array
    {
        foreach ($state['workspaces'] as $index => $workspace) {
            $localId = $workspace['id'] ?? null;
            $cloudId = $workspace['cloud_workspace_id'] ?? null;

            if (! is_string($localId) || ! Str::isUuid($localId)) {
                throw new RuntimeException('The local workspace index contains an invalid workspace.');
            }

            if (is_string($cloudId) && $cloudId !== $localId) {
                if (! Str::isUuid($cloudId)) {
                    throw new RuntimeException('The local workspace index contains an invalid cloud workspace.');
                }

                $this->moveWorkspaceFiles($workspace, $localId, $cloudId);
                $workspace['id'] = $cloudId;
                $workspace['database'] = $workspace['database'] === basename($this->baseDatabasePath)
                    ? $workspace['database']
                    : 'workspaces'.DIRECTORY_SEPARATOR.$cloudId.'.sqlite';

                if ($state['active_workspace_id'] === $localId) {
                    $state['active_workspace_id'] = $cloudId;
                }
            }

            unset($workspace['cloud_workspace_id']);
            $state['workspaces'][$index] = $workspace;
        }

        if (collect($state['workspaces'])->pluck('id')->duplicates()->isNotEmpty()) {
            throw new RuntimeException('The local workspace index contains duplicate workspace IDs.');
        }

        $state['version'] = self::VERSION;

        return $state;
    }

    /** @param array{id: string, database: string} $workspace */
    private function moveWorkspaceFiles(array $workspace, string $localId, string $cloudId): void
    {
        if ($workspace['database'] === basename($this->baseDatabasePath)) {
            return;
        }

        if (! $this->isManagedDatabase($localId, $workspace['database'])) {
            throw new RuntimeException('The local workspace index contains an invalid workspace database.');
        }

        $oldDatabasePath = $this->resolveDatabasePath($workspace['database']);
        $newDatabasePath = $this->resolveDatabasePath(
            'workspaces'.DIRECTORY_SEPARATOR.$cloudId.'.sqlite',
        );

        if ($oldDatabasePath !== $newDatabasePath && file_exists($oldDatabasePath)) {
            if (file_exists($newDatabasePath) || ! rename($oldDatabasePath, $newDatabasePath)) {
                throw new RuntimeException('The workspace database could not adopt its cloud ID.');
            }

            foreach (['-shm', '-wal'] as $suffix) {
                if (file_exists($oldDatabasePath.$suffix)) {
                    rename($oldDatabasePath.$suffix, $newDatabasePath.$suffix);
                }
            }
        }

        $oldStoragePath = dirname($oldDatabasePath).DIRECTORY_SEPARATOR.$localId;
        $newStoragePath = dirname($newDatabasePath).DIRECTORY_SEPARATOR.$cloudId;

        if (is_dir($oldStoragePath) && ! file_exists($newStoragePath) && ! rename($oldStoragePath, $newStoragePath)) {
            throw new RuntimeException('The workspace storage could not adopt its cloud ID.');
        }
    }

    private function migrate(string $databasePath): void
    {
        $connection = 'workspace_setup';
        config(["database.connections.{$connection}" => [
            'driver' => 'sqlite',
            'database' => $databasePath,
            'prefix' => '',
            'foreign_key_constraints' => true,
        ]]);
        DB::purge($connection);

        try {
            $exitCode = Artisan::call('migrate', [
                '--database' => $connection,
                '--force' => true,
                '--no-interaction' => true,
            ]);

            if ($exitCode !== 0) {
                throw new RuntimeException('The workspace database migrations failed.');
            }
        } finally {
            DB::purge($connection);
            config()->offsetUnset("database.connections.{$connection}");
        }
    }

    /** @param array{id: string, database: string} $workspace */
    private function deleteWorkspaceFiles(array $workspace): void
    {
        $databasePath = $this->databasePath($workspace);
        $connection = config('database.default');

        if (is_string($connection)
            && config("database.connections.{$connection}.database") === $databasePath) {
            DB::purge($connection);
        }

        File::delete([
            $databasePath,
            $databasePath.'-shm',
            $databasePath.'-wal',
        ]);

        $storagePath = $this->storagePath($workspace);

        if (! $this->isInsideAppDataDirectory($storagePath)) {
            return;
        }

        $workspaceStoragePath = $workspace['database'] === basename($this->baseDatabasePath)
            ? $storagePath
            : dirname($storagePath);
        File::deleteDirectory($workspaceStoragePath);
    }

    private function isInsideAppDataDirectory(string $path): bool
    {
        $appDataDirectory = realpath($this->appDataDirectory());
        $resolvedPath = realpath($path);

        return $appDataDirectory !== false
            && $resolvedPath !== false
            && $resolvedPath !== $appDataDirectory
            && str_starts_with($resolvedPath, $appDataDirectory.DIRECTORY_SEPARATOR);
    }
}
