<?php

namespace Tests\Feature;

use App\Accounts\CloudAccountStore;
use App\Models\SyncState;
use App\Preferences\UserKeyBindings;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Tests\TestCase;

class CloudAccountTest extends TestCase
{
    use RefreshDatabase;

    private string $directory;

    private CloudAccountStore $accountStore;

    private WorkspaceIndex $workspaces;

    protected function setUp(): void
    {
        parent::setUp();

        $this->directory = sys_get_temp_dir().'/yeidle-account-'.Str::uuid();
        mkdir($this->directory, 0700, true);
        $database = $this->directory.'/nativephp.sqlite';
        touch($database);
        $this->workspaces = new WorkspaceIndex($database);
        $this->accountStore = new CloudAccountStore($this->directory.'/cloud-account.json');
        $keyBindings = new UserKeyBindings(
            $this->directory.'/user-preferences.json',
            $this->accountStore,
        );
        $this->app->instance(WorkspaceIndex::class, $this->workspaces);
        $this->app->instance(CloudAccountStore::class, $this->accountStore);
        $this->app->instance(UserKeyBindings::class, $keyBindings);
        config(['services.yeidle.url' => 'https://cloud.yeidle.test']);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->directory);

        parent::tearDown();
    }

    public function test_browser_sign_in_discovers_workspaces_without_hydrating_them(): void
    {
        Http::fake([
            'https://cloud.yeidle.test/api/device-authorizations' => Http::response([
                'id' => '00000000-0000-7000-8000-000000000201',
                'secret' => str_repeat('s', 64),
                'verification_url' => 'https://cloud.yeidle.test/device/authorize/request',
                'expires_at' => now()->addMinutes(10)->toIso8601String(),
                'realtime' => $this->realtimeConfig(),
            ], 201),
            'https://cloud.yeidle.test/api/device-authorizations/*/token' => Http::response([
                'status' => 'approved',
                'token' => '1|desktop-token',
                'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
                'workspaces' => [
                    ['id' => '00000000-0000-7000-8000-000000000211', 'name' => 'Personal', 'role' => 'owner', 'owned' => true],
                    ['id' => '00000000-0000-7000-8000-000000000212', 'name' => 'Shared Notes', 'role' => 'editor', 'owned' => false],
                ],
                'preferences' => ['key_bindings' => ['all-pages' => 'Mod+Shift+A']],
            ]),
        ]);

        $this->postJson('/api/account/connect', ['device_name' => 'Test desktop'])
            ->assertCreated()
            ->assertJsonPath('status', 'pending');
        $this->postJson('/api/account/complete')
            ->assertSuccessful()
            ->assertJsonPath('status', 'approved')
            ->assertJsonPath('user.email', 'albert@example.com');

        $state = $this->workspaces->state();
        $this->assertCount(3, $state['workspaces']);
        $this->assertSame(
            ['local', 'available', 'available'],
            collect($state['workspaces'])->pluck('cloud_status')->all(),
        );
        $this->assertSame(
            '00000000-0000-7000-8000-000000000211',
            collect($state['workspaces'])->firstWhere(
                'id',
                '00000000-0000-7000-8000-000000000211',
            )['id'],
        );
        $this->assertSame('1|desktop-token', $this->accountStore->account()['token']);
        $this->getJson('/api/key-bindings')
            ->assertJsonPath('bindings.all-pages', 'Mod+Shift+A');
        Http::assertNotSent(fn ($request): bool => $request->method() === 'POST'
            && $request->url() === 'https://cloud.yeidle.test/api/workspaces');
    }

    public function test_pending_browser_sign_in_can_be_cancelled(): void
    {
        Http::fake([
            'https://cloud.yeidle.test/api/device-authorizations' => Http::response([
                'id' => '00000000-0000-7000-8000-000000000201',
                'secret' => str_repeat('s', 64),
                'verification_url' => 'https://cloud.yeidle.test/device/authorize/request',
                'expires_at' => now()->addMinutes(10)->toIso8601String(),
                'realtime' => $this->realtimeConfig(),
            ], 201),
        ]);

        $this->postJson('/api/account/connect', ['device_name' => 'Test desktop'])
            ->assertCreated();
        $this->getJson('/api/account')
            ->assertJsonPath('authorization_pending', true);

        $this->deleteJson('/api/account/connect')
            ->assertSuccessful()
            ->assertJsonPath('cancelled', true);

        $this->getJson('/api/account')
            ->assertJsonPath('authorization_pending', false);
        $this->assertNull($this->accountStore->pending());
    }

    public function test_pending_sign_in_authorizes_only_its_private_realtime_channel(): void
    {
        $authorizationId = '00000000-0000-7000-8000-000000000201';
        $channel = "private-device-authorizations.{$authorizationId}";
        Http::fake([
            'https://cloud.yeidle.test/api/device-authorizations' => Http::response([
                'id' => $authorizationId,
                'secret' => str_repeat('s', 64),
                'verification_url' => 'https://cloud.yeidle.test/device/authorize/request',
                'expires_at' => now()->addMinutes(10)->toIso8601String(),
                'realtime' => $this->realtimeConfig(),
            ], 201),
            "https://cloud.yeidle.test/api/device-authorizations/{$authorizationId}/broadcasting-auth" => Http::response([
                'auth' => 'signed-device-channel',
            ]),
        ]);

        $this->postJson('/api/account/connect', ['device_name' => 'Test desktop'])
            ->assertCreated()
            ->assertJsonPath('realtime.app_key', 'public-key');

        $this->postJson('/api/account/broadcasting-auth', [
            'socket_id' => '123.456',
            'channel_name' => $channel,
        ])->assertOk()->assertJsonPath('auth', 'signed-device-channel');

        Http::assertSent(fn ($request): bool => $request->url()
            === "https://cloud.yeidle.test/api/device-authorizations/{$authorizationId}/broadcasting-auth"
            && $request['secret'] === str_repeat('s', 64)
            && $request['socket_id'] === '123.456'
            && $request['channel_name'] === $channel);

        Http::fake();

        $this->postJson('/api/account/broadcasting-auth', [
            'socket_id' => '123.456',
            'channel_name' => 'private-device-authorizations.someone-else',
        ])->assertForbidden();

        Http::assertNothingSent();
    }

    public function test_local_workspace_only_uses_its_existing_id_when_cloud_sync_is_enabled(): void
    {
        $this->accountStore->saveAccount([
            'cloud_url' => 'https://cloud.yeidle.test',
            'token' => '1|desktop-token',
            'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
            'workspaces' => [],
            'preferences' => ['key_bindings' => []],
        ]);
        Http::fake(function ($request) {
            if ($request->method() === 'POST'
                && $request->url() === 'https://cloud.yeidle.test/api/workspaces') {
                return Http::response(['workspace' => [
                    'id' => $request['id'],
                    'name' => $request['name'],
                    'role' => 'owner',
                    'owned' => true,
                ]], 201);
            }

            return Http::response([], 404);
        });

        $workspace = $this->postJson('/api/workspaces', ['name' => 'Local Notes'])
            ->assertCreated()
            ->assertJsonPath('workspace.cloud_status', 'local')
            ->json('workspace');

        Http::assertNothingSent();

        $this->postJson("/api/workspaces/{$workspace['id']}/sync")
            ->assertSuccessful()
            ->assertJsonPath('workspace.id', $workspace['id'])
            ->assertJsonPath('workspace.cloud_status', 'available')
            ->assertJsonPath('workspace.cloud_owned', true);

        Http::assertSent(fn ($request): bool => $request->method() === 'POST'
            && $request->url() === 'https://cloud.yeidle.test/api/workspaces'
            && $request['id'] === $workspace['id']);
        $this->assertSame($workspace['id'], $this->workspaces->find($workspace['id'])['id']);
        $this->assertArrayNotHasKey('cloud_workspace_id', $workspace);
    }

    public function test_cloud_workspace_owner_can_rename_it(): void
    {
        $workspaceId = '00000000-0000-7000-8000-000000000221';
        $catalogWorkspace = [
            'id' => $workspaceId,
            'name' => 'Old name',
            'role' => 'owner',
            'owned' => true,
        ];
        $this->accountStore->saveAccount([
            'cloud_url' => 'https://cloud.yeidle.test',
            'token' => '1|desktop-token',
            'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
            'workspaces' => [$catalogWorkspace],
            'preferences' => ['key_bindings' => []],
        ]);
        $this->workspaces->syncCloudCatalog('42', [$catalogWorkspace]);
        Http::fake([
            "https://cloud.yeidle.test/api/workspaces/{$workspaceId}" => Http::response([
                'workspace' => [
                    ...$catalogWorkspace,
                    'name' => 'New name',
                ],
            ]),
        ]);

        $this->patchJson("/api/workspaces/{$workspaceId}", ['name' => 'New name'])
            ->assertSuccessful()
            ->assertJsonPath('workspace.name', 'New name')
            ->assertJsonPath('workspace.cloud_owned', true);

        Http::assertSent(fn ($request): bool => $request->method() === 'PATCH'
            && $request->url() === "https://cloud.yeidle.test/api/workspaces/{$workspaceId}"
            && $request['name'] === 'New name');
        $this->assertSame('New name', $this->workspaces->find($workspaceId)['name']);
    }

    public function test_cloud_workspace_owner_can_delete_it(): void
    {
        $workspaceId = '00000000-0000-7000-8000-000000000231';
        $catalogWorkspace = [
            'id' => $workspaceId,
            'name' => 'Cloud notes',
            'role' => 'owner',
            'owned' => true,
        ];
        $this->accountStore->saveAccount([
            'cloud_url' => 'https://cloud.yeidle.test',
            'token' => '1|desktop-token',
            'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
            'workspaces' => [$catalogWorkspace],
            'preferences' => ['key_bindings' => []],
        ]);
        $this->workspaces->syncCloudCatalog('42', [$catalogWorkspace]);
        $workspace = $this->workspaces->find($workspaceId);
        $databasePath = $this->workspaces->databasePath($workspace);
        Http::fake([
            "https://cloud.yeidle.test/api/workspaces/{$workspaceId}" => Http::response([
                'deleted' => true,
            ]),
        ]);

        $this->deleteJson("/api/workspaces/{$workspaceId}")
            ->assertSuccessful()
            ->assertJsonMissing(['id' => $workspaceId]);

        Http::assertSent(fn ($request): bool => $request->method() === 'DELETE'
            && $request->url() === "https://cloud.yeidle.test/api/workspaces/{$workspaceId}");
        $this->assertFileDoesNotExist($databasePath);
        $this->assertSame([], $this->accountStore->account()['workspaces']);
    }

    public function test_shared_cloud_workspace_cannot_be_deleted(): void
    {
        $workspaceId = '00000000-0000-7000-8000-000000000232';
        $catalogWorkspace = [
            'id' => $workspaceId,
            'name' => 'Shared notes',
            'role' => 'editor',
            'owned' => false,
        ];
        $this->workspaces->syncCloudCatalog('42', [$catalogWorkspace]);
        Http::fake();

        $this->deleteJson("/api/workspaces/{$workspaceId}")
            ->assertUnprocessable()
            ->assertJsonPath('message', 'Only the workspace owner can delete it.');

        Http::assertNothingSent();
        $this->assertSame($workspaceId, $this->workspaces->find($workspaceId)['id']);
    }

    public function test_signing_out_keeps_the_last_cloud_identity_for_offline_preferences(): void
    {
        $this->accountStore->saveAccount([
            'cloud_url' => 'https://cloud.yeidle.test',
            'token' => '1|desktop-token',
            'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
            'workspaces' => [],
            'preferences' => ['key_bindings' => []],
        ]);
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000096',
            'last_server_seq' => 0,
            'cloud_url' => 'https://cloud.yeidle.test',
            'cloud_token' => '1|desktop-token',
            'workspace_id' => '00000000-0000-7000-8000-000000000241',
            'cloud_user_id' => '42',
        ]);
        $this->putJson('/api/preferences/theme', ['theme' => 'tokyo-night'])
            ->assertSuccessful();
        Http::fake([
            'https://cloud.yeidle.test/api/device' => Http::response([
                'deleted' => true,
            ]),
        ]);

        $this->deleteJson('/api/account')
            ->assertSuccessful()
            ->assertJsonPath('signed_out', true);

        $state->refresh();
        $this->assertNull($state->cloud_url);
        $this->assertNull($state->cloud_token);
        $this->assertNull($state->workspace_id);
        $this->assertSame('42', $state->cloud_user_id);
        $this->assertNull($this->accountStore->account());
        $this->getJson('/api/preferences')
            ->assertSuccessful()
            ->assertJsonPath('theme', 'tokyo-night');
    }

    public function test_shortcut_changes_are_uploaded_to_the_signed_in_account(): void
    {
        $this->accountStore->saveAccount([
            'cloud_url' => 'https://cloud.yeidle.test',
            'token' => '1|desktop-token',
            'user' => ['id' => '42', 'name' => 'Albert', 'email' => 'albert@example.com'],
            'workspaces' => [],
            'preferences' => ['key_bindings' => []],
        ]);
        Http::fake([
            'https://cloud.yeidle.test/api/user/preferences' => Http::response([
                'key_bindings' => ['all-pages' => 'Mod+Shift+A'],
            ]),
        ]);

        $this->putJson('/api/key-bindings', [
            'bindings' => ['all-pages' => 'Mod+Shift+A'],
        ])->assertSuccessful();

        Http::assertSent(fn ($request): bool => $request->method() === 'PUT'
            && $request->url() === 'https://cloud.yeidle.test/api/user/preferences'
            && $request['key_bindings']['all-pages'] === 'Mod+Shift+A');
        $this->assertFalse($this->accountStore->account()['preferences_dirty']);
    }

    /**
     * @return array{enabled: true, app_key: string, host: string, port: int, scheme: string}
     */
    private function realtimeConfig(): array
    {
        return [
            'enabled' => true,
            'app_key' => 'public-key',
            'host' => 'ws.yeidle.test',
            'port' => 443,
            'scheme' => 'https',
        ];
    }
}
