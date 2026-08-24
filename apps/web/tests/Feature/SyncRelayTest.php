<?php

use App\Events\WorkspaceOpsCommitted;
use App\Models\Node;
use App\Models\Op;
use App\Models\User;
use App\Models\Workspace;
use App\Sync\HlcGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\Event;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

function makeOp(string $type, array $payload, int $millis, string $client = 'device-a'): array
{
    return [
        'op_id' => fake()->uuid(),
        'client_id' => $client,
        'hlc' => HlcGenerator::encode($millis, 0, $client),
        'type' => $type,
        'payload' => $payload,
    ];
}

function setOp(string $id, array $fields, int $millis, string $client = 'device-a'): array
{
    return makeOp('node.set', ['v' => 1, 'id' => $id, 'page_id' => $id, 'fields' => $fields], $millis, $client);
}

function syncUrl(string $endpoint, ?Workspace $workspace = null): string
{
    if ($workspace === null) {
        $user = auth()->user();

        if (! $user instanceof User) {
            throw new RuntimeException('An authenticated user is required to infer a workspace.');
        }

        $workspace = $user->workspaces()->firstOrCreate([], ['name' => 'Personal']);
    }

    return "/api/workspaces/{$workspace->id}/sync/{$endpoint}";
}

test('sync endpoints require authentication', function () {
    $workspace = Workspace::factory()->create();

    $this->postJson(syncUrl('push', $workspace), [])->assertUnauthorized();
    $this->getJson(syncUrl('pull', $workspace).'?since=0')->assertUnauthorized();
    $this->getJson(syncUrl('bootstrap', $workspace))->assertUnauthorized();
});

test('push assigns server sequence, stamps the user, and applies', function () {
    $user = User::factory()->create();
    Sanctum::actingAs($user);

    $id = fake()->uuid();
    $response = $this->postJson(syncUrl('push'), [
        'client_id' => 'device-a',
        'ops' => [setOp($id, ['content' => 'from device a'], 100)],
    ]);

    $response->assertOk();
    expect($response->json('accepted.0.server_seq'))->toBeInt();

    $op = Op::sole();
    expect($op->user_id)->toBe($user->id);
    expect($op->workspace_id)->toBe($user->workspaces()->sole()->id);
    expect(Node::find($id)->content)->toBe('from device a');
});

test('push broadcasts newly committed ops in pull wire format', function () {
    $user = User::factory()->create();
    $workspace = Workspace::factory()->for($user)->create();
    Sanctum::actingAs($user);
    Event::fake([WorkspaceOpsCommitted::class]);

    $operation = setOp(fake()->uuid(), ['content' => 'broadcast me'], 100);

    $response = $this->postJson(syncUrl('push'), [
        'client_id' => 'installation-a',
        'ops' => [$operation],
    ])->assertSuccessful();

    Event::assertDispatched(WorkspaceOpsCommitted::class, function (WorkspaceOpsCommitted $event) use ($operation, $response, $workspace): bool {
        return $event->workspaceId === $workspace->id
            && $event->originClientId === 'installation-a'
            && $event->previousSeq === 0
            && $event->latestSeq === $response->json('accepted.0.server_seq')
            && $event->ops === [[
                'server_seq' => $response->json('accepted.0.server_seq'),
                'op_id' => $operation['op_id'],
                'client_id' => $operation['client_id'],
                'hlc' => $operation['hlc'],
                'type' => $operation['type'],
                'payload' => $operation['payload'],
            ]];
    });
});

test('push is idempotent by op id', function () {
    $user = User::factory()->create();
    Workspace::factory()->for($user)->create();
    Sanctum::actingAs($user);
    Event::fake([WorkspaceOpsCommitted::class]);

    $op = setOp(fake()->uuid(), ['content' => 'once'], 100);

    $first = $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [$op]]);
    $second = $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [$op]]);

    $second->assertOk();
    expect($second->json('accepted.0.server_seq'))->toBe($first->json('accepted.0.server_seq'));
    expect(Op::count())->toBe(1);
    Event::assertDispatchedTimes(WorkspaceOpsCommitted::class, 1);
});

test('oversized broadcasts send a sequence hint without operation contents', function () {
    $user = User::factory()->create();
    Workspace::factory()->for($user)->create();
    Sanctum::actingAs($user);
    Event::fake([WorkspaceOpsCommitted::class]);
    config()->set('reverb.broadcast_max_payload_size', 1);

    $this->postJson(syncUrl('push'), [
        'client_id' => 'installation-a',
        'ops' => [setOp(fake()->uuid(), ['content' => 'pull this instead'], 100)],
    ])->assertSuccessful();

    Event::assertDispatched(
        WorkspaceOpsCommitted::class,
        fn (WorkspaceOpsCommitted $event): bool => $event->ops === null
            && $event->previousSeq === 0
            && $event->latestSeq > 0,
    );
});

test('workspace broadcast cursors chain across globally non-contiguous sequences', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();
    Workspace::factory()->for($alice)->create();
    Workspace::factory()->for($bob)->create();
    Event::fake([WorkspaceOpsCommitted::class]);

    Sanctum::actingAs($alice);
    $first = $this->postJson(syncUrl('push'), [
        'client_id' => 'alice-a',
        'ops' => [setOp(fake()->uuid(), ['content' => 'alice first'], 100)],
    ])->json('accepted.0.server_seq');

    Sanctum::actingAs($bob);
    $this->postJson(syncUrl('push'), [
        'client_id' => 'bob-a',
        'ops' => [setOp(fake()->uuid(), ['content' => 'bob'], 101)],
    ])->assertSuccessful();

    Sanctum::actingAs($alice);
    $latest = $this->postJson(syncUrl('push'), [
        'client_id' => 'alice-b',
        'ops' => [setOp(fake()->uuid(), ['content' => 'alice second'], 102)],
    ])->json('accepted.0.server_seq');

    expect($latest)->toBeGreaterThan($first + 1);
    Event::assertDispatched(
        WorkspaceOpsCommitted::class,
        fn (WorkspaceOpsCommitted $event): bool => $event->originClientId === 'alice-b'
            && $event->previousSeq === $first
            && $event->latestSeq === $latest,
    );
});

test('pull returns ops after the cursor in order', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [
        setOp(fake()->uuid(), ['content' => 'first'], 100),
        setOp(fake()->uuid(), ['content' => 'second'], 101),
    ]])->assertOk();

    $all = $this->getJson(syncUrl('pull').'?since=0');
    expect($all->json('ops'))->toHaveCount(2);
    expect($all->json('ops.0.payload.fields.content'))->toBe('first');

    $latest = $all->json('latest_seq');
    $none = $this->getJson(syncUrl('pull')."?since={$latest}");
    expect($none->json('ops'))->toHaveCount(0);
    expect($none->json('latest_seq'))->toBe($latest);
});

test('workspaces are isolated between users', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();

    Sanctum::actingAs($alice);
    $nodeId = fake()->uuid();
    $this->postJson(syncUrl('push'), ['client_id' => 'a', 'ops' => [
        setOp($nodeId, ['content' => 'alice secret'], 100),
    ]])->assertOk();

    Sanctum::actingAs($bob);
    $pull = $this->getJson(syncUrl('pull').'?since=0');
    expect($pull->json('ops'))->toHaveCount(0);

    $bootstrap = $this->getJson(syncUrl('bootstrap'));
    expect($bootstrap->json('nodes'))->toHaveCount(0);

    // Bob referencing Alice's node id cannot touch her data
    $this->postJson(syncUrl('push'), ['client_id' => 'b', 'ops' => [
        setOp($nodeId, ['content' => 'bob overwrite attempt'], 999999),
    ]])->assertOk();

    expect(Node::find($nodeId)->content)->toBe('alice secret');
});

test('multiple workspaces owned by one user have independent logs and projections', function () {
    $user = User::factory()->create();
    $personal = Workspace::factory()->for($user)->create(['name' => 'Personal']);
    $knowledge = Workspace::factory()->for($user)->create(['name' => 'Albert Knowledge']);
    Sanctum::actingAs($user);

    $nodeId = fake()->uuid();
    $this->postJson(syncUrl('push', $knowledge), [
        'client_id' => 'importer',
        'ops' => [setOp($nodeId, ['content' => 'Roam import'], 100)],
    ])->assertSuccessful();

    $this->getJson(syncUrl('pull', $personal).'?since=0')
        ->assertSuccessful()
        ->assertJsonCount(0, 'ops');
    $this->getJson(syncUrl('bootstrap', $personal))
        ->assertSuccessful()
        ->assertJsonCount(0, 'nodes');
    $this->getJson(syncUrl('bootstrap', $knowledge))
        ->assertSuccessful()
        ->assertJsonPath('nodes.0.id', $nodeId);
});

test('a user cannot address another users workspace directly', function () {
    $workspace = Workspace::factory()->create();
    Sanctum::actingAs(User::factory()->create());

    $this->getJson(syncUrl('status', $workspace))->assertNotFound();
});

test('replaying another workspaces op id does not leak or apply', function () {
    $alice = User::factory()->create();
    Sanctum::actingAs($alice);

    $op = setOp(fake()->uuid(), ['content' => 'alice data'], 100);
    $this->postJson(syncUrl('push'), ['client_id' => 'a', 'ops' => [$op]])->assertOk();

    $bob = User::factory()->create();
    Sanctum::actingAs($bob);
    $replay = $this->postJson(syncUrl('push'), ['client_id' => 'b', 'ops' => [$op]]);

    $replay->assertOk();
    expect($replay->json('accepted'))->toHaveCount(0);
    expect(Op::count())->toBe(1);
});

test('bootstrap returns the projection with clocks and a consistent cursor', function () {
    Sanctum::actingAs(User::factory()->create());

    $id = fake()->uuid();
    $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [
        setOp($id, ['content' => 'snapshot me'], 100),
        makeOp('node.delete', ['v' => 1, 'id' => $id, 'page_id' => $id], 200),
    ]])->assertOk();

    $bootstrap = $this->getJson(syncUrl('bootstrap'));
    $bootstrap->assertOk();

    $node = collect($bootstrap->json('nodes'))->firstWhere('id', $id);
    expect($node)->not->toBeNull();
    expect($node['field_clocks'])->toHaveKey('deleted');
    expect($node['modified_hlc'])->toBe($node['field_clocks']['deleted']);
    expect($node['deleted_at'])->not->toBeNull();
    expect($bootstrap->json('latest_seq'))->toBe($this->getJson(syncUrl('pull').'?since=0')->json('latest_seq'));
});

test('status reports the workspace cursor cheaply', function () {
    Sanctum::actingAs(User::factory()->create());

    $empty = $this->getJson(syncUrl('status'));
    $empty->assertSuccessful();
    expect($empty->json('latest_seq'))->toBe(0);

    $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [
        setOp(fake()->uuid(), ['content' => 'x'], 100),
    ]])->assertSuccessful();

    expect($this->getJson(syncUrl('status'))->json('latest_seq'))->toBeGreaterThan(0);
});

test('status exposes public realtime settings without the app secret', function () {
    Sanctum::actingAs(User::factory()->create());
    config()->set('broadcasting.default', 'reverb');
    config()->set('reverb.public', [
        'app_key' => 'public-key',
        'host' => 'ws.example.test',
        'port' => 443,
        'scheme' => 'https',
    ]);

    $response = $this->getJson(syncUrl('status'))->assertSuccessful();

    $response->assertJsonPath('realtime.enabled', true)
        ->assertJsonPath('realtime.app_key', 'public-key')
        ->assertJsonPath('realtime.host', 'ws.example.test')
        ->assertJsonMissingPath('realtime.app_secret');
});

function configureReverbForChannelAuth(): void
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

test('workspace owners may authorize their private broadcast channel', function () {
    $owner = User::factory()->create();
    $workspace = Workspace::factory()->for($owner)->create();
    configureReverbForChannelAuth();
    Sanctum::actingAs($owner);

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ])->assertSuccessful()->assertJsonStructure(['auth']);
});

test('other users may not authorize a workspace private broadcast channel', function () {
    $workspace = Workspace::factory()->create();
    configureReverbForChannelAuth();
    Sanctum::actingAs(User::factory()->create());

    $this->postJson('/api/broadcasting/auth', [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ])->assertForbidden();
});

test('workspace broadcast authorization requires authentication', function () {
    $workspace = Workspace::factory()->create();
    configureReverbForChannelAuth();
    $payload = [
        'socket_id' => '123.456',
        'channel_name' => "private-workspaces.{$workspace->id}.sync",
    ];

    $this->postJson('/api/broadcasting/auth', $payload)->assertUnauthorized();
});

test('media create ops flow through the relay', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [
        makeOp('media.create', [
            'v' => 1,
            'id' => fake()->uuid(),
            'hash' => str_repeat('ab', 32),
            'original_name' => 'photo.jpg',
            'mime_type' => 'image/jpeg',
            'size' => 1234,
        ], 100),
    ]])->assertOk();

    $bootstrap = $this->getJson(syncUrl('bootstrap'));
    expect($bootstrap->json('media'))->toHaveCount(1);
    expect($bootstrap->json('media.0.filename'))->toBe(str_repeat('ab', 32));
});

test('media create ops with non canonical hashes are dropped', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->postJson(syncUrl('push'), ['client_id' => 'd', 'ops' => [
        makeOp('media.create', [
            'v' => 1,
            'id' => fake()->uuid(),
            'hash' => '../../not-a-blob',
            'original_name' => 'unsafe.bin',
            'mime_type' => 'application/octet-stream',
            'size' => 10,
        ], 100),
    ]])->assertOk();

    expect($this->getJson(syncUrl('bootstrap'))->json('media'))->toBeEmpty();
});
