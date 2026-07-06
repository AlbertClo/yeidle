<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use App\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SyncController extends Controller
{
    public function __construct(
        private SyncService $sync,
    ) {}

    public function push(Request $request): JsonResponse
    {
        $request->validate([
            'client_id' => ['required', 'string'],
            'ops' => ['required', 'array', 'max:1000'],
            'ops.*.op_id' => ['required', 'string', 'uuid'],
            'ops.*.client_id' => ['required', 'string'],
            'ops.*.hlc' => ['required', 'string', 'regex:/^\d{15}-[0-9a-f]{4}-.+$/'],
            'ops.*.type' => ['required', 'string', 'in:node.set,node.delete,node.purge,media.create'],
            'ops.*.payload' => ['required', 'array'],
            'ops.*.payload.id' => ['required', 'string', 'uuid'],
            'ops.*.payload.fields' => ['array'],
        ]);

        // Raw input, not the validated subset: validation keeps only keys
        // with explicit rules and would strip payload fields from the log
        $accepted = $this->sync->push(
            $this->workspaceFor($request),
            $request->user(),
            $request->input('ops'),
        );

        return response()->json(['accepted' => $accepted]);
    }

    public function pull(Request $request): JsonResponse
    {
        $request->validate([
            'since' => ['required', 'integer', 'min:0'],
        ]);

        return response()->json(
            $this->sync->pull($this->workspaceFor($request), (int) $request->input('since')),
        );
    }

    public function bootstrap(Request $request): JsonResponse
    {
        return response()->json(
            $this->sync->bootstrap($this->workspaceFor($request)),
        );
    }

    /**
     * Phase 1: every user gets one personal workspace, created on first
     * use. Multiple workspaces become a route parameter later (§14).
     */
    private function workspaceFor(Request $request): Workspace
    {
        return $request->user()->workspaces()->firstOrCreate([], [
            'name' => 'Personal',
        ]);
    }
}
