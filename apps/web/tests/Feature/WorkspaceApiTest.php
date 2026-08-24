<?php

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

test('workspace endpoints require authentication', function () {
    $this->getJson('/api/workspaces')->assertUnauthorized();
    $this->postJson('/api/workspaces', ['name' => 'Private'])->assertUnauthorized();
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
    Sanctum::actingAs($user);

    $created = $this->postJson('/api/workspaces', ['name' => '  Albert Knowledge  '])
        ->assertCreated()
        ->assertJsonPath('workspace.name', 'Albert Knowledge')
        ->json('workspace');

    $this->getJson('/api/workspaces')
        ->assertSuccessful()
        ->assertJsonCount(1, 'workspaces')
        ->assertJsonPath('workspaces.0.id', $created['id'])
        ->assertJsonMissing(['id' => $otherWorkspace->id]);
});
