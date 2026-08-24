<?php

namespace App\Http\Controllers;

use App\Models\Op;
use App\Models\SyncState;
use App\Sync\CloudBlobService;
use App\Sync\CloudSyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CloudController extends Controller
{
    public function __construct(
        private CloudSyncService $cloud,
        private CloudBlobService $blobs,
    ) {}

    public function connect(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'url' => ['required', 'url'],
            'token' => ['required', 'string'],
        ]);

        try {
            $result = $this->cloud->connect($validated['url'], $validated['token']);
        } catch (\RuntimeException $e) {
            return response()->json(['message' => $e->getMessage()], 422);
        }

        return response()->json($result);
    }

    public function status(): JsonResponse
    {
        $state = SyncState::current();
        $configured = $state !== null && $state->cloud_url !== null;

        $health = match (true) {
            ! $configured => 'unconfigured',
            $state->last_sync_error !== null => 'error',
            $state->cloud_seed_pending => 'seeding',
            $state->last_sync_success_at !== null => 'healthy',
            default => 'never_synced',
        };

        return response()->json([
            'configured' => $configured,
            'health' => $health,
            'cloud_url' => $state?->cloud_url,
            'cloud_seed_pending' => (bool) ($state?->cloud_seed_pending ?? false),
            'last_server_seq' => (int) ($state?->last_server_seq ?? 0),
            'local_log_seq' => (int) (Op::max('id') ?? 0),
            'outbox' => Op::whereNull('server_seq')->count(),
            'pending_blob_uploads' => $this->blobs->pendingUploadCount(),
            'last_sync_attempt_at' => $state?->last_sync_attempt_at?->toIso8601String(),
            'last_sync_success_at' => $state?->last_sync_success_at?->toIso8601String(),
            'last_sync_error' => $state?->last_sync_error,
        ]);
    }

    public function exchange(): JsonResponse
    {
        return response()->json($this->cloud->exchange());
    }

    public function realtimeConfig(): JsonResponse
    {
        try {
            return response()->json($this->cloud->realtimeConfig());
        } catch (\RuntimeException) {
            return response()->json([
                'message' => 'Realtime sync configuration is unavailable.',
            ], 503);
        }
    }

    public function authorizeRealtime(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'socket_id' => ['required', 'string', 'regex:/^\d+\.\d+$/'],
            'channel_name' => ['required', 'string'],
        ]);

        try {
            return response()->json($this->cloud->authorizeRealtime(
                $validated['socket_id'],
                $validated['channel_name'],
            ));
        } catch (\RuntimeException) {
            return response()->json(['message' => 'Realtime authorization failed.'], 403);
        }
    }

    public function ingestRealtimeOps(Request $request): JsonResponse
    {
        $request->validate([
            'workspace_id' => ['required', 'string'],
            'origin_client_id' => ['required', 'string'],
            'previous_seq' => ['required', 'integer', 'min:0'],
            'latest_seq' => ['required', 'integer', 'min:1'],
            'ops' => ['nullable', 'array', 'max:200'],
            'ops.*.server_seq' => ['required', 'integer', 'min:1'],
            'ops.*.op_id' => ['required', 'string', 'uuid'],
            'ops.*.client_id' => ['required', 'string'],
            'ops.*.hlc' => ['required', 'string', 'regex:/^\d{15}-[0-9a-f]{4}-.+$/'],
            'ops.*.type' => ['required', 'string', 'in:node.set,node.delete,node.purge,media.create'],
            'ops.*.payload' => ['required', 'array'],
            'ops.*.payload.id' => ['required', 'string', 'uuid'],
            'ops.*.payload.fields' => ['array'],
        ]);

        try {
            return response()->json($this->cloud->ingestCommittedOps(
                $request->string('workspace_id')->toString(),
                $request->string('origin_client_id')->toString(),
                (int) $request->input('previous_seq'),
                (int) $request->input('latest_seq'),
                $request->input('ops'),
            ));
        } catch (\RuntimeException) {
            return response()->json([
                'message' => 'Realtime operations could not be applied.',
                'needs_pull' => true,
            ], 422);
        }
    }
}
