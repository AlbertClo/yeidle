<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use App\Sync\DocumentRelay;
use App\Sync\RealtimeSettings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The Loro document relay: devices push opaque update bytes and pull the
 * workspace's log after a cursor.
 */
class DocumentSyncController extends Controller
{
    public function __construct(
        private DocumentRelay $relay,
    ) {}

    public function push(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        $validated = $request->validate([
            'device_id' => ['required', 'string', 'max:100'],
            'updates' => ['required', 'array', 'max:500'],
            'updates.*.update_id' => ['required', 'string', 'max:64', 'distinct'],
            'updates.*.document_id' => ['required', 'string', 'max:64'],
            'updates.*.bytes' => ['required', 'string', 'regex:/^[A-Za-z0-9+\/]+={0,2}$/'],
        ]);

        $acks = $this->relay->push(
            $workspace,
            $request->user(),
            $validated['device_id'],
            $validated['updates'],
        );

        return response()->json(['accepted' => $acks]);
    }

    public function pull(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        $validated = $request->validate([
            'since' => ['required', 'integer', 'min:0'],
            'limit' => ['nullable', 'integer', 'min:1', 'max:'.DocumentRelay::PULL_MAX_UPDATES],
            'exclude_device' => ['nullable', 'string', 'max:100'],
        ]);

        return response()->json($this->relay->pull(
            $workspace,
            (int) $validated['since'],
            (int) ($validated['limit'] ?? DocumentRelay::PULL_MAX_UPDATES),
            $validated['exclude_device'] ?? null,
        ));
    }

    /**
     * Cheap probe for pairing: token validity, the log's cursor position, and
     * the public realtime settings.
     */
    public function status(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        return response()->json([
            'workspace_id' => $workspace->id,
            'user_id' => (string) $request->user()->getAuthIdentifier(),
            'latest_seq' => $this->relay->latestSeq($workspace),
            'realtime' => RealtimeSettings::public(),
        ]);
    }

    private function authorizeWorkspace(Request $request, Workspace $workspace): void
    {
        abort_unless(
            $request->user()->workspaces()->whereKey($workspace->id)->exists(),
            404,
        );
    }
}
