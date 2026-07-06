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

        return response()->json([
            'configured' => $state !== null && $state->cloud_url !== null,
            'cloud_url' => $state?->cloud_url,
            'last_server_seq' => (int) ($state?->last_server_seq ?? 0),
            'outbox' => Op::whereNull('server_seq')->count(),
        ]);
    }

    public function exchange(): JsonResponse
    {
        return response()->json($this->cloud->exchange());
    }
}
