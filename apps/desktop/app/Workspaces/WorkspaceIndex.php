<?php

namespace App\Workspaces;

use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use JsonException;
use RuntimeException;
use Throwable;

final class WorkspaceIndex
{
    private const VERSION = 1;

    private string $indexPath;

    private readonly string $baseStoragePath;

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
    public function create(string $name): array
    {
        $name = trim($name);

        if ($name === '') {
            throw new RuntimeException('Workspace name cannot be empty.');
        }

        $workspaceId = (string) Str::uuid7();
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

        $workspace = [
            'id' => $workspaceId,
            'name' => $name,
            'database' => $relativeDatabasePath,
        ];
        $state = $this->read();
        $state['workspaces'][] = $workspace;
        $this->write($state);

        return $workspace;
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

        config(["database.connections.{$connection}.database" => $this->databasePath($workspace)]);
        DB::purge($connection);
        DB::connection($connection)->statement('PRAGMA journal_mode=WAL;');
        DB::connection($connection)->statement('PRAGMA busy_timeout=5000;');

        $storagePath = $this->storagePath($workspace);

        if (! is_dir($storagePath) && ! mkdir($storagePath, 0700, true) && ! is_dir($storagePath)) {
            throw new RuntimeException('The workspace storage directory could not be created.');
        }

        config(['filesystems.disks.local.root' => $storagePath]);
        Storage::forgetDisk('local');
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
            || ($state['version'] ?? null) !== self::VERSION
            || ! is_string($state['active_workspace_id'] ?? null)
            || ! is_array($state['workspaces'] ?? null)) {
            throw new RuntimeException('The local workspace index is invalid.');
        }

        foreach ($state['workspaces'] as $workspace) {
            if (! is_array($workspace)
                || ! is_string($workspace['id'] ?? null)
                || ! is_string($workspace['name'] ?? null)
                || ! is_string($workspace['database'] ?? null)
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
}
