<?php

namespace App\Documents;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Storage for Loro documents: a compacted snapshot per document plus the
 * append-only update log. Bytes are stored raw and exchanged as base64.
 */
class DocumentStore
{
    /**
     * Creates the document row if needed. Called first in every write
     * transaction so SQLite takes its write lock before anything is read.
     */
    public function lock(string $documentId): void
    {
        DB::table('documents')->insertOrIgnore([
            'id' => $documentId,
            'snapshot_seq' => 0,
            'updated_at' => now(),
        ]);
        DB::table('documents')->where('id', $documentId)->update(['updated_at' => now()]);
    }

    /**
     * Everything needed to rebuild the current document state.
     *
     * @return array{id: string, snapshot: ?string, updates: list<string>, seq: int}
     */
    public function load(string $documentId): array
    {
        $document = DB::table('documents')->where('id', $documentId)->first();
        $snapshotSeq = (int) ($document->snapshot_seq ?? 0);
        $updates = DB::table('document_updates')
            ->where('document_id', $documentId)
            ->where('id', '>', $snapshotSeq)
            ->orderBy('id')
            ->get(['id', 'bytes']);

        return [
            'id' => $documentId,
            'snapshot' => $document?->snapshot !== null && $document?->snapshot !== ''
                ? base64_encode($document->snapshot)
                : null,
            'updates' => $updates->map(fn ($row) => base64_encode($row->bytes))->all(),
            'seq' => max($snapshotSeq, (int) ($updates->last()->id ?? 0), $this->latestSeq($documentId)),
        ];
    }

    public function latestSeq(string $documentId): int
    {
        return (int) (DB::table('document_updates')->where('document_id', $documentId)->max('id') ?? 0);
    }

    /**
     * Appends an update unless its update_id is already stored. Returns the
     * local sequence and whether it was new.
     *
     * @return array{seq: int, new: bool}
     */
    public function append(
        string $documentId,
        string $bytesBase64,
        string $clientId,
        ?string $updateId = null,
        ?int $cloudSeq = null,
    ): array {
        $updateId ??= (string) Str::uuid7();
        $existing = DB::table('document_updates')->where('update_id', $updateId)->value('id');

        if ($existing !== null) {
            return ['seq' => (int) $existing, 'new' => false];
        }

        $bytes = base64_decode($bytesBase64, true);

        if ($bytes === false || $bytes === '') {
            throw new \InvalidArgumentException('Document update bytes must be non-empty base64.');
        }

        $seq = DB::table('document_updates')->insertGetId([
            'document_id' => $documentId,
            'update_id' => $updateId,
            'client_id' => $clientId,
            'bytes' => $bytes,
            'cloud_seq' => $cloudSeq,
            'created_at' => now(),
        ]);

        return ['seq' => (int) $seq, 'new' => true];
    }

    public function saveSnapshot(string $documentId, string $snapshotBase64, int $seq): void
    {
        DB::table('documents')->where('id', $documentId)->update([
            'snapshot' => base64_decode($snapshotBase64, true),
            'snapshot_seq' => $seq,
            'updated_at' => now(),
        ]);
    }

    /**
     * Updates after the given local sequence, for other windows.
     *
     * @return list<array{seq: int, client_id: string, bytes: string}>
     */
    public function updatesSince(string $documentId, int $since): array
    {
        return DB::table('document_updates')
            ->where('document_id', $documentId)
            ->where('id', '>', $since)
            ->orderBy('id')
            ->get(['id', 'client_id', 'bytes'])
            ->map(fn ($row) => [
                'seq' => (int) $row->id,
                'client_id' => $row->client_id,
                'bytes' => base64_encode($row->bytes),
            ])
            ->all();
    }
}
