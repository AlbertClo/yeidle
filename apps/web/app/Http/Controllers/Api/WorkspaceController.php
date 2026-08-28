<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Workspace;
use App\Workspaces\CreateWorkspace;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class WorkspaceController extends Controller
{
    public function __construct(private readonly CreateWorkspace $createWorkspace) {}

    public function index(Request $request): JsonResponse
    {
        $query = fn () => $request->user()->workspaces()
            ->orderBy('workspaces.created_at')
            ->get([
                'workspaces.id',
                'workspaces.user_id',
                'workspaces.name',
                'workspaces.created_at',
                'workspaces.updated_at',
            ]);
        $workspaces = $query();

        if ($workspaces->isEmpty()) {
            $this->createWorkspace->create($request->user(), 'Personal');
            $workspaces = $query();
        }

        return response()->json(['workspaces' => $workspaces->map(fn ($workspace) => [
            'id' => $workspace->id,
            'name' => $workspace->name,
            'role' => $workspace->pivot->role,
            'owned' => $workspace->user_id === $request->user()->id,
            'created_at' => $workspace->created_at,
            'updated_at' => $workspace->updated_at,
        ])]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => ['sometimes', 'required', 'uuid', 'unique:workspaces,id'],
            'name' => ['required', 'string', 'max:100'],
        ]);
        $name = trim($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages([
                'name' => 'The workspace name field is required.',
            ]);
        }

        $workspace = $this->createWorkspace->create(
            $request->user(),
            $name,
            $validated['id'] ?? null,
        );

        return response()->json(['workspace' => [
            'id' => $workspace->id,
            'name' => $workspace->name,
            'role' => 'owner',
            'owned' => true,
            'created_at' => $workspace->created_at,
            'updated_at' => $workspace->updated_at,
        ]], 201);
    }

    public function update(Request $request, Workspace $workspace): JsonResponse
    {
        abort_unless(
            (int) $workspace->user_id === (int) $request->user()->getKey(),
            403,
        );

        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
        ]);
        $name = trim($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages([
                'name' => 'The workspace name field is required.',
            ]);
        }

        $workspace->update(['name' => $name]);

        return response()->json(['workspace' => [
            'id' => $workspace->id,
            'name' => $workspace->name,
            'role' => 'owner',
            'owned' => true,
            'created_at' => $workspace->created_at,
            'updated_at' => $workspace->updated_at,
        ]]);
    }

    public function destroy(Request $request, Workspace $workspace): JsonResponse
    {
        abort_unless(
            (int) $workspace->user_id === (int) $request->user()->getKey(),
            403,
        );

        $workspace->delete();

        return response()->json(['deleted' => true]);
    }
}
