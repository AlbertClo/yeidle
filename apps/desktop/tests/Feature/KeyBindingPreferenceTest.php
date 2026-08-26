<?php

namespace Tests\Feature;

use App\Models\SyncState;
use App\Preferences\UserKeyBindings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Tests\TestCase;

class KeyBindingPreferenceTest extends TestCase
{
    use RefreshDatabase;

    private string $directory;

    private string $path;

    protected function setUp(): void
    {
        parent::setUp();

        $this->directory = sys_get_temp_dir().'/yeidle-key-bindings-'.Str::uuid();
        $this->path = $this->directory.'/user-preferences.json';
        $this->app->instance(UserKeyBindings::class, new UserKeyBindings($this->path));
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->directory);

        parent::tearDown();
    }

    public function test_it_returns_defaults_and_saves_overrides_outside_the_workspace_database(): void
    {
        $this->getJson('/api/key-bindings')
            ->assertSuccessful()
            ->assertJsonPath('bindings.command-palette', 'Mod+P')
            ->assertJsonPath('bindings.toggle-checkbox', 'Mod+Enter')
            ->assertJsonPath('bindings.pinned-item-1', 'Alt+1')
            ->assertJsonPath('bindings.pinned-item-10', 'Alt+0');

        $this->putJson('/api/key-bindings', [
            'bindings' => [
                'command-palette' => 'Mod+Shift+P',
                'toggle-pin' => null,
            ],
        ])
            ->assertSuccessful()
            ->assertJsonPath('bindings.command-palette', 'Mod+Shift+P')
            ->assertJsonPath('bindings.toggle-pin', null)
            ->assertJsonPath('bindings.all-pages', 'Alt+A');

        $this->assertFileExists($this->path);
        $this->assertDatabaseCount('nodes', 0);
        $this->assertDatabaseCount('ops', 0);
    }

    public function test_bindings_are_scoped_to_the_cloud_user_and_shared_local_profile_is_adopted(): void
    {
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000097',
            'last_server_seq' => 0,
        ]);

        $this->putJson('/api/key-bindings', [
            'bindings' => ['all-pages' => 'Mod+Shift+A'],
        ])->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-a']);
        $this->getJson('/api/key-bindings')
            ->assertJsonPath('bindings.all-pages', 'Mod+Shift+A');

        $this->putJson('/api/key-bindings', [
            'bindings' => ['all-pages' => 'Mod+Shift+B'],
        ])->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-b']);
        $this->getJson('/api/key-bindings')
            ->assertJsonPath('bindings.all-pages', 'Mod+Shift+A');

        $state->update(['cloud_user_id' => 'user-a']);
        $this->getJson('/api/key-bindings')
            ->assertJsonPath('bindings.all-pages', 'Mod+Shift+B');
    }

    public function test_it_rejects_unknown_invalid_and_conflicting_bindings(): void
    {
        $this->putJson('/api/key-bindings', [
            'bindings' => ['unknown' => 'Mod+U'],
        ])->assertUnprocessable()->assertJsonValidationErrors('bindings');

        $this->putJson('/api/key-bindings', [
            'bindings' => ['all-pages' => 'A'],
        ])->assertUnprocessable()->assertJsonValidationErrors('bindings');

        $this->putJson('/api/key-bindings', [
            'bindings' => ['all-pages' => 'Mod+P'],
        ])->assertUnprocessable()->assertJsonValidationErrors('bindings');
    }
}
