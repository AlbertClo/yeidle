<?php

use App\Models\Node;
use App\Models\Op;
use App\Models\User;
use App\Sync\HlcGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
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

test('sync endpoints require authentication', function () {
    $this->postJson('/api/sync/push', [])->assertUnauthorized();
    $this->getJson('/api/sync/pull?since=0')->assertUnauthorized();
    $this->getJson('/api/sync/bootstrap')->assertUnauthorized();
});

test('push assigns server sequence, stamps the user, and applies', function () {
    $user = User::factory()->create();
    Sanctum::actingAs($user);

    $id = fake()->uuid();
    $response = $this->postJson('/api/sync/push', [
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

test('push is idempotent by op id', function () {
    Sanctum::actingAs(User::factory()->create());

    $op = setOp(fake()->uuid(), ['content' => 'once'], 100);

    $first = $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [$op]]);
    $second = $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [$op]]);

    $second->assertOk();
    expect($second->json('accepted.0.server_seq'))->toBe($first->json('accepted.0.server_seq'));
    expect(Op::count())->toBe(1);
});

test('pull returns ops after the cursor in order', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [
        setOp(fake()->uuid(), ['content' => 'first'], 100),
        setOp(fake()->uuid(), ['content' => 'second'], 101),
    ]])->assertOk();

    $all = $this->getJson('/api/sync/pull?since=0');
    expect($all->json('ops'))->toHaveCount(2);
    expect($all->json('ops.0.payload.fields.content'))->toBe('first');

    $latest = $all->json('latest_seq');
    $none = $this->getJson("/api/sync/pull?since={$latest}");
    expect($none->json('ops'))->toHaveCount(0);
    expect($none->json('latest_seq'))->toBe($latest);
});

test('workspaces are isolated between users', function () {
    $alice = User::factory()->create();
    $bob = User::factory()->create();

    Sanctum::actingAs($alice);
    $nodeId = fake()->uuid();
    $this->postJson('/api/sync/push', ['client_id' => 'a', 'ops' => [
        setOp($nodeId, ['content' => 'alice secret'], 100),
    ]])->assertOk();

    Sanctum::actingAs($bob);
    $pull = $this->getJson('/api/sync/pull?since=0');
    expect($pull->json('ops'))->toHaveCount(0);

    $bootstrap = $this->getJson('/api/sync/bootstrap');
    expect($bootstrap->json('nodes'))->toHaveCount(0);

    // Bob referencing Alice's node id cannot touch her data
    $this->postJson('/api/sync/push', ['client_id' => 'b', 'ops' => [
        setOp($nodeId, ['content' => 'bob overwrite attempt'], 999999),
    ]])->assertOk();

    expect(Node::find($nodeId)->content)->toBe('alice secret');
});

test('replaying another workspaces op id does not leak or apply', function () {
    $alice = User::factory()->create();
    Sanctum::actingAs($alice);

    $op = setOp(fake()->uuid(), ['content' => 'alice data'], 100);
    $this->postJson('/api/sync/push', ['client_id' => 'a', 'ops' => [$op]])->assertOk();

    $bob = User::factory()->create();
    Sanctum::actingAs($bob);
    $replay = $this->postJson('/api/sync/push', ['client_id' => 'b', 'ops' => [$op]]);

    $replay->assertOk();
    expect($replay->json('accepted'))->toHaveCount(0);
    expect(Op::count())->toBe(1);
});

test('bootstrap returns the projection with clocks and a consistent cursor', function () {
    Sanctum::actingAs(User::factory()->create());

    $id = fake()->uuid();
    $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [
        setOp($id, ['content' => 'snapshot me'], 100),
        makeOp('node.delete', ['v' => 1, 'id' => $id, 'page_id' => $id], 200),
    ]])->assertOk();

    $bootstrap = $this->getJson('/api/sync/bootstrap');
    $bootstrap->assertOk();

    $node = collect($bootstrap->json('nodes'))->firstWhere('id', $id);
    expect($node)->not->toBeNull();
    expect($node['field_clocks'])->toHaveKey('deleted');
    expect($node['deleted_at'])->not->toBeNull();
    expect($bootstrap->json('latest_seq'))->toBe($this->getJson('/api/sync/pull?since=0')->json('latest_seq'));
});

test('status reports the workspace cursor cheaply', function () {
    Sanctum::actingAs(User::factory()->create());

    $empty = $this->getJson('/api/sync/status');
    $empty->assertSuccessful();
    expect($empty->json('latest_seq'))->toBe(0);

    $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [
        setOp(fake()->uuid(), ['content' => 'x'], 100),
    ]])->assertSuccessful();

    expect($this->getJson('/api/sync/status')->json('latest_seq'))->toBeGreaterThan(0);
});

test('media create ops flow through the relay', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->postJson('/api/sync/push', ['client_id' => 'd', 'ops' => [
        makeOp('media.create', [
            'v' => 1,
            'id' => fake()->uuid(),
            'hash' => str_repeat('ab', 32),
            'original_name' => 'photo.jpg',
            'mime_type' => 'image/jpeg',
            'size' => 1234,
        ], 100),
    ]])->assertOk();

    $bootstrap = $this->getJson('/api/sync/bootstrap');
    expect($bootstrap->json('media'))->toHaveCount(1);
    expect($bootstrap->json('media.0.filename'))->toBe(str_repeat('ab', 32));
});
