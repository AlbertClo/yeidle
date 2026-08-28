<?php

namespace App\Http\Controllers;

use App\Accounts\CloudAccountService;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class WorkspaceController extends Controller
{
    public function __construct(
        private readonly WorkspaceIndex $workspaces,
        private readonly CloudAccountService $cloudAccount,
    ) {}

    public function index(): JsonResponse
    {
        return response()->json($this->workspaces->state());
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
        ]);

        try {
            $workspace = $this->workspaces->create($validated['name']);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json(['workspace' => $workspace], 201);
    }

    public function update(Request $request, string $workspaceId): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
        ]);

        try {
            $workspace = $this->workspaces->find($workspaceId);
            $workspace = $workspace['cloud_status'] === 'local'
                ? $this->workspaces->rename($workspaceId, $validated['name'])
                : $this->cloudAccount->renameWorkspace($workspaceId, $validated['name']);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json(['workspace' => $workspace]);
    }

    public function sync(string $workspaceId): JsonResponse
    {
        try {
            $workspace = $this->cloudAccount->enableWorkspaceSync($workspaceId);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json(['workspace' => $workspace]);
    }

    public function destroy(string $workspaceId): JsonResponse
    {
        try {
            $workspace = $this->workspaces->find($workspaceId);
            $state = $workspace['cloud_status'] === 'local'
                ? $this->workspaces->delete($workspaceId)
                : $this->cloudAccount->deleteWorkspace($workspaceId);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }

        return response()->json($state);
    }

    public function activate(string $workspaceId): JsonResponse
    {
        try {
            $workspace = $this->workspaces->activate($workspaceId);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 404);
        }

        return response()->json(['workspace' => $workspace]);
    }
}
