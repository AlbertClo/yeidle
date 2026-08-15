<?php

namespace App\Http\Controllers;

use App\Models\Op;
use App\Models\SyncState;
use App\Sync\CloudSyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CloudController extends Controller
{
    public function __construct(
        private CloudSyncService $cloud,
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
            'outbox' => Op::whereNull('server_seq')->count(),
            'last_sync_attempt_at' => $state?->last_sync_attempt_at?->toIso8601String(),
            'last_sync_success_at' => $state?->last_sync_success_at?->toIso8601String(),
            'last_sync_error' => $state?->last_sync_error,
        ]);
    }

    public function exchange(): JsonResponse
    {
        return response()->json($this->cloud->exchange());
    }
}
