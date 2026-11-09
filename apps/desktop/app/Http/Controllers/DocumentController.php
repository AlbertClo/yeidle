<?php

namespace App\Http\Controllers;

use App\Documents\DocumentService;
use App\Documents\DocumentStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class DocumentController extends Controller
{
    public function __construct(
        private DocumentStore $store,
        private DocumentService $documents,
    ) {}

    /** The document's snapshot plus later updates, for an editor to load. */
    public function show(string $documentId): JsonResponse
    {
        return response()->json($this->store->load($documentId));
    }

    /** Stores updates from an editor window and re-projects the document. */
    public function push(Request $request, string $documentId): JsonResponse
    {
        $request->validate([
            'updates' => ['required', 'array', 'min:1', 'max:200'],
            'updates.*.update_id' => ['required', 'uuid'],
            'updates.*.client_id' => ['required', 'string', 'max:100'],
            'updates.*.bytes' => ['required', 'string'],
        ]);

        $seq = $this->documents->applyUpdates($documentId, $request->input('updates'));

        return response()->json(['seq' => $seq]);
    }

    /** Updates after a local sequence, for windows that have the document open. */
    public function updates(Request $request, string $documentId): JsonResponse
    {
        $since = (int) $request->validate(['since' => ['required', 'integer', 'min:0']])['since'];

        return response()->json([
            'updates' => $this->store->updatesSince($documentId, $since),
            'seq' => max($since, $this->store->latestSeq($documentId)),
        ]);
    }

    /** Which documents changed after a local sequence (workspace-wide). */
    public function changes(Request $request): JsonResponse
    {
        $since = (int) $request->validate(['since' => ['required', 'integer', 'min:0']])['since'];
        $rows = DB::table('document_updates')
            ->where('id', '>', $since)
            ->groupBy('document_id')
            ->selectRaw('document_id, max(id) as seq')
            ->get();

        return response()->json([
            'documents' => $rows->map(fn ($row) => [
                'id' => $row->document_id,
                'seq' => (int) $row->seq,
            ])->all(),
            'seq' => max($since, (int) (DB::table('document_updates')->max('id') ?? 0)),
        ]);
    }
}
