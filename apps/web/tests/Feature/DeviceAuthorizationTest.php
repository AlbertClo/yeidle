<?php

use App\Events\DeviceAuthorizationApproved;
use App\Models\DeviceAuthorization;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Event;
use Laravel\Sanctum\PersonalAccessToken;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

test('a desktop app can be approved in the browser and receive an idempotent token', function () {
    $user = User::factory()->create();
    $owned = Workspace::factory()->for($user)->create(['name' => 'Personal']);
    $shared = Workspace::factory()->create(['name' => 'Team Notes']);
    $shared->members()->attach($user, ['role' => 'editor']);

    $authorization = $this->postJson('/api/device-authorizations', [
        'device_name' => 'Albert’s laptop',
    ])
        ->assertCreated()
        ->assertJsonStructure(['id', 'secret', 'verification_url', 'expires_at'])
        ->json();

    $tokenUrl = "/api/device-authorizations/{$authorization['id']}/token";
    $this->postJson($tokenUrl, ['secret' => $authorization['secret']])
        ->assertStatus(202)
        ->assertJsonPath('status', 'pending');

    $this->actingAs($user)
        ->post("/device/authorize/{$authorization['id']}")
        ->assertRedirect();
    auth()->guard('web')->logout();
    $this->flushSession();
    $this->app['auth']->forgetGuards();

    $approved = $this->postJson($tokenUrl, ['secret' => $authorization['secret']])
        ->assertSuccessful()
        ->assertJsonPath('status', 'approved')
        ->assertJsonPath('user.email', $user->email)
        ->assertJsonCount(2, 'workspaces')
        ->json();

    expect(collect($approved['workspaces'])->firstWhere('id', $owned->id))
        ->toMatchArray(['role' => 'owner', 'owned' => true]);
    expect(collect($approved['workspaces'])->firstWhere('id', $shared->id))
        ->toMatchArray(['role' => 'editor', 'owned' => false]);

    $this->postJson($tokenUrl, ['secret' => $authorization['secret']])
        ->assertJsonPath('token', $approved['token']);
    expect(PersonalAccessToken::count())->toBe(1);

    $this->withToken($approved['token'])
        ->getJson('/api/workspaces')
        ->assertSuccessful();
    $this->withToken($approved['token'])
        ->deleteJson('/api/device')
        ->assertSuccessful();
    $this->app['auth']->forgetGuards();
    $this->withToken($approved['token'])
        ->getJson('/api/workspaces')
        ->assertUnauthorized();
});

test('expired and incorrectly signed desktop requests cannot receive tokens', function () {
    $authorization = $this->postJson('/api/device-authorizations', [
        'device_name' => 'Desktop',
    ])->json();

    $this->postJson("/api/device-authorizations/{$authorization['id']}/token", [
        'secret' => str_repeat('x', 64),
    ])->assertNotFound();

    DeviceAuthorization::findOrFail($authorization['id'])
        ->update(['expires_at' => now()->subMinute()]);

    $this->postJson("/api/device-authorizations/{$authorization['id']}/token", [
        'secret' => $authorization['secret'],
    ])->assertGone();
});

test('a pending desktop app can authorize only its private realtime channel', function () {
    configureDeviceAuthorizationReverb();

    $authorization = $this->postJson('/api/device-authorizations', [
        'device_name' => 'Desktop',
    ])
        ->assertCreated()
        ->assertJsonPath('realtime.enabled', true)
        ->assertJsonPath('realtime.app_key', 'public-key')
        ->assertJsonPath('realtime.host', 'ws.example.test')
        ->assertJsonMissingPath('realtime.app_secret')
        ->json();
    $channel = "private-device-authorizations.{$authorization['id']}";
    $url = "/api/device-authorizations/{$authorization['id']}/broadcasting-auth";

    $this->postJson($url, [
        'secret' => $authorization['secret'],
        'socket_id' => '123.456',
        'channel_name' => $channel,
    ])->assertSuccessful()->assertJsonStructure(['auth']);

    $this->postJson($url, [
        'secret' => str_repeat('x', 64),
        'socket_id' => '123.456',
        'channel_name' => $channel,
    ])->assertForbidden();

    $this->postJson($url, [
        'secret' => $authorization['secret'],
        'socket_id' => '123.456',
        'channel_name' => 'private-device-authorizations.someone-else',
    ])->assertForbidden();
});

test('browser approval broadcasts only the approved authorization id', function () {
    Event::fake([DeviceAuthorizationApproved::class]);
    $user = User::factory()->create();
    $authorization = $this->postJson('/api/device-authorizations', [
        'device_name' => 'Desktop',
    ])->json();

    $this->actingAs($user)
        ->post("/device/authorize/{$authorization['id']}")
        ->assertRedirect();

    Event::assertDispatched(
        DeviceAuthorizationApproved::class,
        fn (DeviceAuthorizationApproved $event): bool => $event->authorizationId === $authorization['id']
            && $event->broadcastWith() === ['authorization_id' => $authorization['id']],
    );
});

test('account keyboard preferences are isolated by user', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();

    Sanctum::actingAs($alice);
    $this->putJson('/api/user/preferences', [
        'key_bindings' => ['all-pages' => 'Mod+Shift+A', 'toggle-pin' => null],
    ])
        ->assertSuccessful()
        ->assertJsonPath('key_bindings.all-pages', 'Mod+Shift+A')
        ->assertJsonPath('key_bindings.toggle-pin', null);

    Sanctum::actingAs($bob);
    $this->getJson('/api/user/preferences')
        ->assertSuccessful()
        ->assertJsonPath('key_bindings', []);
});

function configureDeviceAuthorizationReverb(): void
{
    config()->set('broadcasting.default', 'reverb');
    config()->set('broadcasting.connections.reverb', [
        'driver' => 'reverb',
        'key' => 'public-key',
        'secret' => 'private-secret',
        'app_id' => 'test-app',
        'options' => [],
    ]);
    config()->set('reverb.public', [
        'app_key' => 'public-key',
        'host' => 'ws.example.test',
        'port' => 443,
        'scheme' => 'https',
    ]);
    Broadcast::purge('reverb');
}
