<?php

namespace Tests\Feature;

use App\Workspaces\WorkspaceIndex;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Native\Desktop\Facades\Shell;
use RuntimeException;
use Tests\TestCase;

class WorkspaceTest extends TestCase
{
    use RefreshDatabase;

    private string $directory;

    private WorkspaceIndex $workspaces;

    protected function setUp(): void
    {
        parent::setUp();

        $this->directory = sys_get_temp_dir().'/yeidle-workspaces-'.Str::uuid();
        mkdir($this->directory, 0700, true);
        $baseDatabase = $this->directory.'/nativephp.sqlite';
        touch($baseDatabase);
        $this->workspaces = new WorkspaceIndex($baseDatabase);
        $this->app->instance(WorkspaceIndex::class, $this->workspaces);
    }

    protected function tearDown(): void
    {
        $this->deleteDirectory($this->directory);

        parent::tearDown();
    }

    public function test_existing_database_is_adopted_as_the_personal_workspace(): void
    {
        $state = $this->workspaces->state();

        $this->assertCount(1, $state['workspaces']);
        $this->assertSame('Personal', $state['workspaces'][0]['name']);
        $this->assertSame('nativephp.sqlite', $state['workspaces'][0]['database']);
        $this->assertSame($state['workspaces'][0]['id'], $state['active_workspace_id']);
    }

    public function test_new_workspace_gets_a_separate_migrated_database(): void
    {
        $workspace = $this->workspaces->create('Albert Knowledge');
        $databasePath = $this->workspaces->databasePath($workspace);

        $this->assertFileExists($databasePath);
        $this->assertNotSame($this->directory.'/nativephp.sqlite', $databasePath);
        $this->assertSame('Albert Knowledge', $workspace['name']);
        $this->assertSame(
            $this->directory."/workspaces/{$workspace['id']}/storage",
            $this->workspaces->storagePath($workspace),
        );

        $connection = 'workspace_assertion';
        config(["database.connections.{$connection}" => [
            'driver' => 'sqlite',
            'database' => $databasePath,
            'prefix' => '',
            'foreign_key_constraints' => true,
        ]]);

        $this->assertTrue(
            $this->app->make('db')->connection($connection)->getSchemaBuilder()->hasTable('nodes'),
        );
        $this->assertTrue(
            $this->app->make('db')->connection($connection)->getSchemaBuilder()->hasTable('sync_state'),
        );
        $this->assertNotNull(
            $this->app->make('db')->connection($connection)->selectOne(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_search'",
            ),
        );
    }

    public function test_workspace_api_lists_creates_and_activates_local_workspaces(): void
    {
        $initial = $this->getJson('/api/workspaces')
            ->assertSuccessful()
            ->assertJsonCount(1, 'workspaces')
            ->json();

        $created = $this->postJson('/api/workspaces', ['name' => 'Roam Import'])
            ->assertCreated()
            ->assertJsonPath('workspace.name', 'Roam Import')
            ->json('workspace');

        $this->postJson("/api/workspaces/{$created['id']}/activate")
            ->assertSuccessful()
            ->assertJsonPath('workspace.id', $created['id'])
            ->assertJsonMissingPath('relaunching');

        $this->getJson('/api/workspaces')
            ->assertJsonCount(2, 'workspaces')
            ->assertJsonPath('active_workspace_id', $created['id']);

        $this->assertNotSame($initial['active_workspace_id'], $created['id']);
    }

    public function test_local_workspace_can_be_renamed(): void
    {
        $workspace = $this->workspaces->create('Old name');

        $this->patchJson("/api/workspaces/{$workspace['id']}", [
            'name' => '  New name  ',
        ])
            ->assertSuccessful()
            ->assertJsonPath('workspace.name', 'New name')
            ->assertJsonPath('workspace.cloud_status', 'local');

        $this->assertSame('New name', $this->workspaces->find($workspace['id'])['name']);
    }

    public function test_workspace_database_can_be_shown_on_disk(): void
    {
        $shell = Shell::fake();
        $workspace = $this->workspaces->create('Find me');
        $databasePath = $this->workspaces->databasePath($workspace);

        $this->postJson("/api/workspaces/{$workspace['id']}/show-on-disk")
            ->assertSuccessful();

        $shell->assertShowInFolder($databasePath);
    }

    public function test_workspace_media_folder_can_be_shown_on_disk(): void
    {
        $shell = Shell::fake();
        $workspace = $this->workspaces->create('Find my media');
        $mediaPath = $this->workspaces->mediaBackupPath($workspace);

        $this->postJson("/api/workspaces/{$workspace['id']}/show-on-disk", [
            'target' => 'media',
        ])->assertSuccessful();

        $this->assertDirectoryExists($mediaPath);
        $shell->assertShowInFolder($mediaPath);
    }

    public function test_local_workspace_can_be_deleted(): void
    {
        $workspace = $this->workspaces->create('Temporary');
        $databasePath = $this->workspaces->databasePath($workspace);
        $storagePath = $this->workspaces->storagePath($workspace);
        mkdir($storagePath, 0700, true);
        file_put_contents($storagePath.'/attachment.txt', 'temporary');
        $this->workspaces->activate($workspace['id']);

        $state = $this->deleteJson("/api/workspaces/{$workspace['id']}")
            ->assertSuccessful()
            ->assertJsonCount(1, 'workspaces')
            ->json();

        $this->assertNotSame($workspace['id'], $state['active_workspace_id']);
        $this->assertFileDoesNotExist($databasePath);
        $this->assertDirectoryDoesNotExist(dirname($storagePath));
    }

    public function test_deleting_the_only_workspace_creates_a_fresh_personal_workspace(): void
    {
        $initial = $this->workspaces->active();
        $initialDatabasePath = $this->workspaces->databasePath($initial);

        $state = $this->workspaces->delete($initial['id']);
        $replacement = $state['workspaces'][0];

        $this->assertCount(1, $state['workspaces']);
        $this->assertNotSame($initial['id'], $replacement['id']);
        $this->assertSame('Personal', $replacement['name']);
        $this->assertSame($replacement['id'], $state['active_workspace_id']);
        $this->assertFileDoesNotExist($initialDatabasePath);
        $this->assertFileExists($this->workspaces->databasePath($replacement));
    }

    public function test_cloud_catalog_uses_cloud_ids_for_lazy_placeholders_without_pairing_by_name(): void
    {
        $state = $this->workspaces->syncCloudCatalog('user-1', [
            [
                'id' => '00000000-0000-7000-8000-000000000111',
                'name' => 'Personal',
                'role' => 'owner',
                'owned' => true,
            ],
            [
                'id' => '00000000-0000-7000-8000-000000000112',
                'name' => 'Shared Research',
                'role' => 'editor',
                'owned' => false,
            ],
        ]);

        $this->assertCount(3, $state['workspaces']);
        $localPersonal = collect($state['workspaces'])->firstWhere('cloud_status', 'local');
        $personal = collect($state['workspaces'])->firstWhere(
            'id',
            '00000000-0000-7000-8000-000000000111',
        );
        $shared = collect($state['workspaces'])->firstWhere(
            'id',
            '00000000-0000-7000-8000-000000000112',
        );

        $this->assertSame('Personal', $localPersonal['name']);
        $this->assertSame('00000000-0000-7000-8000-000000000111', $personal['id']);
        $this->assertSame('available', $personal['cloud_status']);
        $this->assertSame('editor', $shared['cloud_role']);
        $this->assertFalse($shared['cloud_owned']);
        $this->assertFileExists($this->workspaces->databasePath($shared));
        $this->assertFalse(
            DB::connection()->table('nodes')->where('page_id', $shared['id'])->exists(),
        );

        $refreshed = $this->workspaces->syncCloudCatalog('user-1', [
            [
                'id' => '00000000-0000-7000-8000-000000000111',
                'name' => 'Personal renamed',
                'role' => 'owner',
                'owned' => true,
            ],
            [
                'id' => '00000000-0000-7000-8000-000000000112',
                'name' => 'Shared Research',
                'role' => 'editor',
                'owned' => false,
            ],
        ]);

        $this->assertCount(3, $refreshed['workspaces']);
        $this->assertSame(
            'Personal renamed',
            collect($refreshed['workspaces'])
                ->firstWhere('id', '00000000-0000-7000-8000-000000000111')['name'],
        );
    }

    public function test_cloud_catalog_links_an_existing_local_workspace_only_by_its_id(): void
    {
        $workspaceId = '00000000-0000-7000-8000-000000000121';
        $this->workspaces->create('Local Draft', $workspaceId);

        $state = $this->workspaces->syncCloudCatalog('user-1', [[
            'id' => $workspaceId,
            'name' => 'Cloud Name',
            'role' => 'owner',
            'owned' => true,
        ]]);
        $workspace = collect($state['workspaces'])->firstWhere('id', $workspaceId);

        $this->assertCount(2, $state['workspaces']);
        $this->assertSame('Cloud Name', $workspace['name']);
        $this->assertSame('available', $workspace['cloud_status']);
        $this->assertArrayNotHasKey('cloud_workspace_id', $workspace);
    }

    public function test_version_two_registry_adopts_the_cloud_id_without_losing_local_files(): void
    {
        $workspace = $this->workspaces->create('Existing Sync');
        $oldDatabasePath = $this->workspaces->databasePath($workspace);
        $oldStoragePath = $this->workspaces->storagePath($workspace);
        mkdir($oldStoragePath, 0700, true);
        file_put_contents($oldStoragePath.'/kept.txt', 'kept');
        $cloudId = '00000000-0000-7000-8000-000000000131';
        $indexPath = $this->directory.'/workspaces.json';
        $index = json_decode(file_get_contents($indexPath), true, flags: JSON_THROW_ON_ERROR);
        $index['version'] = 2;
        $index['active_workspace_id'] = $workspace['id'];

        foreach ($index['workspaces'] as &$entry) {
            $entry['cloud_workspace_id'] = $entry['id'] === $workspace['id']
                ? $cloudId
                : null;
        }
        unset($entry);

        file_put_contents($indexPath, json_encode($index, JSON_THROW_ON_ERROR));

        $state = (new WorkspaceIndex($this->directory.'/nativephp.sqlite'))->state();
        $upgraded = collect($state['workspaces'])->firstWhere('id', $cloudId);

        $this->assertSame($cloudId, $state['active_workspace_id']);
        $this->assertNotNull($upgraded);
        $this->assertFileDoesNotExist($oldDatabasePath);
        $this->assertFileExists($this->directory."/workspaces/{$cloudId}.sqlite");
        $this->assertFileExists($this->directory."/workspaces/{$cloudId}/storage/kept.txt");
        $this->assertArrayNotHasKey('cloud_workspace_id', $upgraded);
    }

    public function test_selecting_an_existing_workspace_applies_pending_migrations(): void
    {
        $workspace = $this->workspaces->create('Older Workspace');
        $databasePath = $this->workspaces->databasePath($workspace);
        $schemaConnection = 'workspace_old_schema';
        $activeConnection = 'workspace_active_test';
        $originalConnection = DB::getDefaultConnection();
        $connectionConfig = [
            'driver' => 'sqlite',
            'database' => $databasePath,
            'prefix' => '',
            'foreign_key_constraints' => true,
        ];
        config([
            "database.connections.{$schemaConnection}" => $connectionConfig,
            "database.connections.{$activeConnection}" => $connectionConfig,
        ]);

        try {
            DB::setDefaultConnection($schemaConnection);
            $migration = require database_path('migrations/2026_08_25_000000_create_node_search_index.php');
            $migration->down();
            DB::table('migrations')
                ->where('migration', '2026_08_25_000000_create_node_search_index')
                ->delete();

            DB::setDefaultConnection($activeConnection);
            $this->workspaces->configureActiveConnection($workspace['id']);

            $this->assertNotNull(
                DB::connection($activeConnection)->selectOne(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'node_search'",
                ),
            );
        } finally {
            DB::setDefaultConnection($originalConnection);
            DB::purge($schemaConnection);
            DB::purge($activeConnection);
            config()->offsetUnset("database.connections.{$schemaConnection}");
            config()->offsetUnset("database.connections.{$activeConnection}");
        }
    }

    public function test_missing_workspace_database_is_recreated_and_migrated(): void
    {
        $workspace = $this->workspaces->create('Missing database');
        $databasePath = $this->workspaces->databasePath($workspace);
        $connection = 'workspace_missing_database';
        $originalConnection = DB::getDefaultConnection();

        unlink($databasePath);
        config(["database.connections.{$connection}" => [
            'driver' => 'sqlite',
            'database' => $databasePath,
            'prefix' => '',
            'foreign_key_constraints' => true,
        ]]);

        try {
            DB::setDefaultConnection($connection);
            $this->workspaces->configureActiveConnection($workspace['id']);

            $this->assertFileExists($databasePath);
            $this->assertTrue($this->workspaces->recoveredMissingDatabase());
            $this->assertTrue(DB::connection($connection)->getSchemaBuilder()->hasTable('nodes'));
            $this->assertTrue(DB::connection($connection)->getSchemaBuilder()->hasTable('sync_state'));
        } finally {
            DB::setDefaultConnection($originalConnection);
            DB::purge($connection);
            config()->offsetUnset("database.connections.{$connection}");
        }
    }

    public function test_unknown_workspace_cannot_be_activated(): void
    {
        $this->postJson('/api/workspaces/'.Str::uuid().'/activate')
            ->assertNotFound();
    }

    public function test_invalid_index_does_not_fall_back_to_another_database(): void
    {
        file_put_contents($this->directory.'/workspaces.json', '{bad json');

        $this->expectException(RuntimeException::class);
        $this->workspaces->state();
    }

    public function test_index_cannot_point_a_workspace_outside_the_managed_directory(): void
    {
        $workspaceId = (string) Str::uuid7();
        file_put_contents($this->directory.'/workspaces.json', json_encode([
            'version' => 1,
            'active_workspace_id' => $workspaceId,
            'workspaces' => [[
                'id' => $workspaceId,
                'name' => 'Escaped',
                'database' => '../outside/db.sqlite',
            ]],
        ], JSON_THROW_ON_ERROR));

        $this->expectException(RuntimeException::class);
        $this->workspaces->state();
    }

    private function deleteDirectory(string $directory): void
    {
        if (! is_dir($directory)) {
            return;
        }

        $entries = scandir($directory);

        if ($entries === false) {
            return;
        }

        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $path = $directory.DIRECTORY_SEPARATOR.$entry;

            if (is_dir($path)) {
                $this->deleteDirectory($path);
            } else {
                unlink($path);
            }
        }

        rmdir($directory);
    }
}
