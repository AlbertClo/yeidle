<?php

namespace Tests\Feature;

use App\Workspaces\WorkspaceIndex;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
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
