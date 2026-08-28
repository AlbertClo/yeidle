<?php

namespace App\Http\Controllers;

use App\Workspaces\CreateWorkspace;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Inertia\Inertia;
use Inertia\Response;
use Laravel\Sanctum\PersonalAccessToken;

class DashboardController extends Controller
{
    public function index(Request $request): Response
    {
        $user = $request->user();
        $workspaces = $user->workspaces()
            ->orderBy('workspaces.created_at')
            ->get(['workspaces.id', 'workspaces.user_id', 'workspaces.name'])
            ->map(fn ($workspace) => [
                'id' => $workspace->id,
                'name' => $workspace->name,
                'role' => $workspace->pivot->role,
                'owned' => $workspace->user_id === $user->id,
            ]);
        $devices = $user->tokens()
            ->latest()
            ->get()
            ->map(fn (PersonalAccessToken $token) => [
                'id' => $token->id,
                'name' => $token->name,
                'last_used_at' => $token->last_used_at?->toIso8601String(),
                'created_at' => $token->created_at?->toIso8601String(),
            ]);

        return Inertia::render('Dashboard', [
            'workspaces' => $workspaces,
            'devices' => $devices,
        ]);
    }

    public function storeWorkspace(Request $request, CreateWorkspace $createWorkspace): RedirectResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
        ]);
        $name = trim($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages(['name' => 'Enter a workspace name.']);
        }

        $createWorkspace->create($request->user(), $name);

        return back();
    }

    public function destroyDevice(Request $request, PersonalAccessToken $device): RedirectResponse
    {
        abort_unless($device->tokenable()->is($request->user()), 404);
        $device->delete();

        return back();
    }
}
