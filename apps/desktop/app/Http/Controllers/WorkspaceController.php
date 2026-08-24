<?php

namespace App\Http\Controllers;

use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class WorkspaceController extends Controller
{
    public function __construct(private readonly WorkspaceIndex $workspaces) {}

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
