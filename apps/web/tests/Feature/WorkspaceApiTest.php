<?php

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

test('workspace endpoints require authentication', function () {
    $this->getJson('/api/workspaces')->assertUnauthorized();
    $this->postJson('/api/workspaces', ['name' => 'Private'])->assertUnauthorized();
    $workspace = Workspace::factory()->create();
    $this->patchJson("/api/workspaces/{$workspace->id}", ['name' => 'Renamed'])
        ->assertUnauthorized();
    $this->deleteJson("/api/workspaces/{$workspace->id}")
        ->assertUnauthorized();
});

test('listing creates the first personal workspace when needed', function () {
    $user = User::factory()->create();
    Sanctum::actingAs($user);

    $this->getJson('/api/workspaces')
        ->assertSuccessful()
        ->assertJsonCount(1, 'workspaces')
        ->assertJsonPath('workspaces.0.name', 'Personal');

    expect($user->workspaces()->count())->toBe(1);
});

test('users can create and only list their own workspaces', function () {
    $user = User::factory()->create();
    $otherWorkspace = Workspace::factory()->create();
    $workspaceId = '00000000-0000-7000-8000-000000000301';
    Sanctum::actingAs($user);

    $created = $this->postJson('/api/workspaces', [
        'id' => $workspaceId,
        'name' => '  Albert Knowledge  ',
    ])
        ->assertCreated()
        ->assertJsonPath('workspace.id', $workspaceId)
        ->assertJsonPath('workspace.name', 'Albert Knowledge')
        ->json('workspace');

    $this->getJson('/api/workspaces')
        ->assertSuccessful()
        ->assertJsonCount(1, 'workspaces')
        ->assertJsonPath('workspaces.0.id', $created['id'])
        ->assertJsonMissing(['id' => $otherWorkspace->id]);

    $this->postJson('/api/workspaces', [
        'id' => $workspaceId,
        'name' => 'Duplicate',
    ])->assertUnprocessable()
        ->assertJsonValidationErrors('id');
});

test('shared workspaces appear in the account catalog and use membership access', function () {
    $owner = User::factory()->create();
    $member = User::factory()->create();
    $workspace = Workspace::factory()->for($owner)->create(['name' => 'Shared Notes']);
    $workspace->members()->attach($member, ['role' => 'editor']);
    Sanctum::actingAs($member);

    $this->getJson('/api/workspaces')
        ->assertSuccessful()
        ->assertJsonCount(1, 'workspaces')
        ->assertJsonPath('workspaces.0.id', $workspace->id)
        ->assertJsonPath('workspaces.0.role', 'editor')
        ->assertJsonPath('workspaces.0.owned', false);

    $this->getJson("/api/workspaces/{$workspace->id}/sync/status")
        ->assertSuccessful()
        ->assertJsonPath('workspace_id', $workspace->id);

    $this->patchJson("/api/workspaces/{$workspace->id}", ['name' => 'Taken over'])
        ->assertForbidden();
    $this->deleteJson("/api/workspaces/{$workspace->id}")
        ->assertForbidden();
});

test('workspace owners can rename their workspace', function () {
    $owner = User::factory()->create();
    $workspace = Workspace::factory()->for($owner)->create(['name' => 'Old name']);
    Sanctum::actingAs($owner);

    $this->patchJson("/api/workspaces/{$workspace->id}", [
        'name' => '  New name  ',
    ])
        ->assertSuccessful()
        ->assertJsonPath('workspace.id', $workspace->id)
        ->assertJsonPath('workspace.name', 'New name')
        ->assertJsonPath('workspace.owned', true);

    expect($workspace->fresh()->name)->toBe('New name');
});

test('workspace owners can delete their workspace', function () {
    $owner = User::factory()->create();
    $workspace = Workspace::factory()->for($owner)->create();
    Sanctum::actingAs($owner);

    $this->deleteJson("/api/workspaces/{$workspace->id}")
        ->assertSuccessful()
        ->assertJsonPath('deleted', true);

    $this->assertDatabaseMissing('workspaces', ['id' => $workspace->id]);
});
