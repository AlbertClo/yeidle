<?php

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;

uses(RefreshDatabase::class);

test('guests are redirected to the login page', function () {
    $this->get(route('dashboard'))->assertRedirect(route('login'));
});

test('account dashboard lists owned and shared workspaces and connected devices', function () {
    $user = User::factory()->create();
    Workspace::factory()->for($user)->create(['name' => 'Personal']);
    $shared = Workspace::factory()->create(['name' => 'Shared']);
    $shared->members()->attach($user, ['role' => 'viewer']);
    $token = $user->createToken('Albert’s laptop', ['desktop']);

    $this->actingAs($user)
        ->get('/dashboard')
        ->assertSuccessful()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Dashboard')
            ->has('workspaces', 2)
            ->where('devices.0.name', 'Albert’s laptop'));

    $this->actingAs($user)
        ->delete("/devices/{$token->accessToken->id}")
        ->assertRedirect();
    expect($user->tokens()->count())->toBe(0);
});

test('users can create a workspace from the account dashboard', function () {
    $user = User::factory()->create();

    $this->actingAs($user)
        ->post('/workspaces', ['name' => 'Research'])
        ->assertRedirect();

    expect($user->workspaces()->sole()->name)->toBe('Research');
    expect($user->workspaces()->sole()->pivot->role)->toBe('owner');
});
