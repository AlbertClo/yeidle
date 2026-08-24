<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class WorkspaceController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        $workspaces = $request->user()->workspaces()
            ->orderBy('created_at')
            ->get(['id', 'name', 'created_at', 'updated_at']);

        if ($workspaces->isEmpty()) {
            $workspaces->push($request->user()->workspaces()->create([
                'name' => 'Personal',
            ]));
        }

        return response()->json(['workspaces' => $workspaces]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:100'],
        ]);
        $name = trim($validated['name']);

        if ($name === '') {
            throw ValidationException::withMessages([
                'name' => 'The workspace name field is required.',
            ]);
        }

        $workspace = $request->user()->workspaces()->create([
            'name' => $name,
        ]);

        return response()->json(['workspace' => $workspace], 201);
    }
}
