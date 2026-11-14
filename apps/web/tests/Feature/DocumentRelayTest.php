<?php

use App\Events\DocumentUpdatesCommitted;
use App\Models\User;
use App\Models\Workspace;
use App\Workspaces\CreateWorkspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

function relayWorkspace(User $user): Workspace
{
    return app(CreateWorkspace::class)->create($user, 'Personal');
}

/** @return array{update_id: string, document_id: string, bytes: string} */
function relayUpdate(string $documentId, string $bytes, ?string $updateId = null): array
{
    return [
        'update_id' => $updateId ?? fake()->uuid(),
        'document_id' => $documentId,
        'bytes' => base64_encode($bytes),
    ];
}

test('document endpoints require authentication', function () {
    $workspace = Workspace::factory()->create();

    $this->getJson("/api/workspaces/{$workspace->id}/documents/status")->assertUnauthorized();
    $this->getJson("/api/workspaces/{$workspace->id}/documents/updates?since=0")->assertUnauthorized();
    $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [])->assertUnauthorized();
});

test('non-members cannot reach a workspace log', function () {
    $workspace = Workspace::factory()->create();
    Sanctum::actingAs(User::factory()->create());

    $this->getJson("/api/workspaces/{$workspace->id}/documents/status")->assertNotFound();
    $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [relayUpdate('doc-1', 'x')],
    ])->assertNotFound();
});

test('binary updates round trip unchanged in push order', function () {
    Event::fake([DocumentUpdatesCommitted::class]);
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);

    // Null bytes, high bytes and a long payload (base64 longer than one line)
    $first = "\x00\x01\xff\xfe".random_bytes(300);
    $second = random_bytes(5);

    $accepted = $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [relayUpdate('doc-1', $first), relayUpdate('media', $second)],
    ])->assertSuccessful()->json('accepted');

    expect($accepted)->toHaveCount(2)
        ->and($accepted[0]['server_seq'])->toBeLessThan($accepted[1]['server_seq']);

    $pulled = $this->getJson("/api/workspaces/{$workspace->id}/documents/updates?since=0")
        ->assertSuccessful()
        ->assertJsonPath('has_more', false)
        ->assertJsonPath('latest_seq', $accepted[1]['server_seq'])
        ->json('updates');

    expect($pulled)->toHaveCount(2)
        ->and(base64_decode($pulled[0]['bytes']))->toBe($first)
        ->and($pulled[0]['document_id'])->toBe('doc-1')
        ->and($pulled[0]['device_id'])->toBe('device-a')
        ->and(base64_decode($pulled[1]['bytes']))->toBe($second);

    Event::assertDispatched(
        DocumentUpdatesCommitted::class,
        fn (DocumentUpdatesCommitted $event): bool => $event->workspaceId === $workspace->id
            && $event->originDeviceId === 'device-a'
            && $event->previousSeq === 0
            && $event->latestSeq === $accepted[1]['server_seq'],
    );
});

test('replayed updates are acknowledged with their original sequence and not stored twice', function () {
    Event::fake([DocumentUpdatesCommitted::class]);
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);
    $update = relayUpdate('doc-1', 'abc');

    $first = $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [$update],
    ])->json('accepted.0.server_seq');

    $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [$update],
    ])->assertSuccessful()->assertJsonPath('accepted.0.server_seq', $first);

    $this->getJson("/api/workspaces/{$workspace->id}/documents/updates?since=0")
        ->assertJsonCount(1, 'updates');
    Event::assertDispatchedTimes(DocumentUpdatesCommitted::class, 1);
});

test('the same update id in another workspace is a separate update', function () {
    $user = User::factory()->create();
    $workspaceA = relayWorkspace($user);
    $workspaceB = relayWorkspace($user);
    Sanctum::actingAs($user);
    $update = relayUpdate('media', 'shared');

    foreach ([$workspaceA, $workspaceB] as $workspace) {
        $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
            'device_id' => 'device-a',
            'updates' => [$update],
        ])->assertSuccessful()->assertJsonCount(1, 'accepted');
    }

    $this->getJson("/api/workspaces/{$workspaceA->id}/documents/updates?since=0")
        ->assertJsonCount(1, 'updates');
    $this->getJson("/api/workspaces/{$workspaceB->id}/documents/updates?since=0")
        ->assertJsonCount(1, 'updates');
});

test('pull pages after a cursor', function () {
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);

    $accepted = $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [relayUpdate('a', '1'), relayUpdate('b', '2'), relayUpdate('c', '3')],
    ])->json('accepted');

    $page = $this->getJson("/api/workspaces/{$workspace->id}/documents/updates?since=0&limit=2")
        ->assertJsonPath('has_more', true)
        ->json('updates');

    expect(array_column($page, 'document_id'))->toBe(['a', 'b']);

    $this->getJson("/api/workspaces/{$workspace->id}/documents/updates?since={$accepted[1]['server_seq']}")
        ->assertJsonPath('has_more', false)
        ->assertJsonPath('updates.0.document_id', 'c');
});

test('a device can skip its own updates and still advance its cursor', function () {
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);
    $url = "/api/workspaces/{$workspace->id}/documents/updates";

    $this->postJson($url, ['device_id' => 'device-a', 'updates' => [relayUpdate('a', '1')]]);
    $this->postJson($url, ['device_id' => 'device-b', 'updates' => [relayUpdate('b', '2')]]);
    $own = $this->postJson($url, ['device_id' => 'device-a', 'updates' => [relayUpdate('c', '3')]])
        ->json('accepted.0.server_seq');

    $this->getJson("{$url}?since=0&exclude_device=device-a")
        ->assertJsonCount(1, 'updates')
        ->assertJsonPath('updates.0.device_id', 'device-b')
        ->assertJsonPath('cursor', $own)
        ->assertJsonPath('has_more', false);

    $this->getJson("{$url}?since={$own}&exclude_device=device-a")
        ->assertJsonCount(0, 'updates')
        ->assertJsonPath('cursor', $own);
});

test('status reports the log position and identity', function () {
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);

    $this->getJson("/api/workspaces/{$workspace->id}/documents/status")
        ->assertSuccessful()
        ->assertJsonPath('workspace_id', $workspace->id)
        ->assertJsonPath('user_id', (string) $user->id)
        ->assertJsonPath('latest_seq', 0)
        ->assertJsonStructure(['realtime' => ['enabled']]);
});

test('push rejects malformed updates', function () {
    $user = User::factory()->create();
    $workspace = relayWorkspace($user);
    Sanctum::actingAs($user);

    $this->postJson("/api/workspaces/{$workspace->id}/documents/updates", [
        'device_id' => 'device-a',
        'updates' => [['update_id' => 'u1', 'document_id' => 'doc', 'bytes' => 'not base64!']],
    ])->assertUnprocessable();
});
