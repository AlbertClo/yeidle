<?php

use App\Models\User;
use App\Models\Workspace;
use App\Workspaces\CreateWorkspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Broadcast;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

function channelAuth(): void
{
    config()->set('broadcasting.default', 'reverb');
    config()->set('broadcasting.connections.reverb', [
        'driver' => 'reverb',
        'key' => 'public-key',
        'secret' => 'private-secret',
        'app_id' => 'test-app',
        'options' => [],
    ]);
    Broadcast::purge('reverb');
    require base_path('routes/channels.php');
}

test('workspace members may join a page presence channel and are named in it', function () {
    $user = User::factory()->create(['name' => 'Albert']);
    $workspace = app(CreateWorkspace::class)->create($user, 'Personal');
    channelAuth();
    Sanctum::actingAs($user);

    $response = $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "presence-workspaces.{$workspace->id}.documents.".fake()->uuid(),
    ])->assertSuccessful()->assertJsonStructure(['auth', 'channel_data']);

    expect(json_decode($response->json('channel_data'), true))->toMatchArray([
        'user_id' => (string) $user->id,
        'user_info' => ['id' => (string) $user->id, 'name' => 'Albert'],
    ]);
});

test('others may not join a page presence channel', function () {
    $owner = User::factory()->create();
    $workspace = app(CreateWorkspace::class)->create($owner, 'Personal');
    channelAuth();
    Sanctum::actingAs(User::factory()->create());

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "presence-workspaces.{$workspace->id}.documents.".fake()->uuid(),
    ])->assertForbidden();
});

test('workspace owners may join their sync channel', function () {
    $owner = User::factory()->create();
    $workspace = Workspace::factory()->for($owner)->create();
    channelAuth();
    Sanctum::actingAs($owner);

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ])->assertSuccessful()->assertJsonStructure(['auth']);
});

test('others may not join a workspace sync channel', function () {
    $workspace = Workspace::factory()->create();
    channelAuth();
    Sanctum::actingAs(User::factory()->create());

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ])->assertForbidden();
});

test('joining a workspace sync channel requires authentication', function () {
    $workspace = Workspace::factory()->create();
    channelAuth();

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ])->assertUnauthorized();
});
