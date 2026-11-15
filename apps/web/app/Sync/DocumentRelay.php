<?php

namespace App\Sync;

use App\Events\DocumentUpdatesCommitted;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/**
 * Stores and serves Loro document updates without decoding them. Bytes
 * travel as base64 in JSON and are stored as bytea (decoded in SQL, so no
 * binary string ever goes through a PDO text parameter).
 */
final class DocumentRelay
{
    /** Pull responses stop after this many bytes of updates (at least one is sent). */
    public const PULL_MAX_BYTES = 4 * 1024 * 1024;

    public const PULL_MAX_UPDATES = 500;

    /**
     * Appends a batch. Idempotent per update_id: replays are acknowledged
     * with their original server_seq.
     *
     * @param  list<array{update_id: string, document_id: string, bytes: string}>  $updates
     * @return list<array{update_id: string, server_seq: int}>
     */
    public function push(Workspace $workspace, User $user, string $deviceId, array $updates): array
    {
        return DB::transaction(function () use ($workspace, $user, $deviceId, $updates) {
            // Serialize pushes per workspace so server_seq commits in order
            // and a puller's cursor can never skip a later-committed row
            Workspace::whereKey($workspace->id)->lockForUpdate()->firstOrFail();

            $previousSeq = $this->latestSeq($workspace);
            $now = now();

            foreach ($updates as $update) {
                DB::insert(
                    'INSERT INTO document_updates (workspace_id, document_id, update_id, device_id, user_id, bytes, created_at)
                     VALUES (?, ?, ?, ?, ?, decode(?, \'base64\'), ?)
                     ON CONFLICT (workspace_id, update_id) DO NOTHING',
                    [
                        $workspace->id,
                        $update['document_id'],
                        $update['update_id'],
                        $deviceId,
                        $user->id,
                        $update['bytes'],
                        $now,
                    ],
                );
            }

            $acks = DB::table('document_updates')
                ->where('workspace_id', $workspace->id)
                ->whereIn('update_id', array_column($updates, 'update_id'))
                ->orderBy('server_seq')
                ->get(['update_id', 'server_seq'])
                ->map(fn (object $row): array => [
                    'update_id' => $row->update_id,
                    'server_seq' => (int) $row->server_seq,
                ])
                ->all();

            $latestSeq = $this->latestSeq($workspace);

            if ($latestSeq > $previousSeq) {
                DocumentUpdatesCommitted::dispatch($workspace->id, $deviceId, $previousSeq, $latestSeq);
            }

            return $acks;
        });
    }

    /**
     * Updates after a cursor, capped by count and size. A device can skip its
     * own updates; `cursor` is where the next pull starts either way.
     *
     * @return array{updates: list<array{server_seq: int, document_id: string, update_id: string, device_id: string, bytes: string}>, cursor: int, latest_seq: int, has_more: bool}
     */
    public function pull(Workspace $workspace, int $since, int $limit = self::PULL_MAX_UPDATES, ?string $excludeDevice = null): array
    {
        // Read the log position first: pushes are serialized per workspace,
        // so every row at or below it is already committed and visible
        $latestSeq = $this->latestSeq($workspace);

        $rows = DB::select(
            "SELECT server_seq, document_id, update_id, device_id,
                    translate(encode(bytes, 'base64'), E'\\n', '') AS bytes,
                    octet_length(bytes) AS size
             FROM document_updates
             WHERE workspace_id = ? AND server_seq > ? AND server_seq <= ?
                AND (?::text IS NULL OR device_id <> ?)
             ORDER BY server_seq
             LIMIT ?",
            [$workspace->id, $since, $latestSeq, $excludeDevice, $excludeDevice, $limit + 1],
        );

        $updates = [];
        $total = 0;
        $hasMore = count($rows) > $limit;

        foreach (array_slice($rows, 0, $limit) as $row) {
            if ($updates !== [] && $total + $row->size > self::PULL_MAX_BYTES) {
                $hasMore = true;

                break;
            }

            $total += $row->size;
            $updates[] = [
                'server_seq' => (int) $row->server_seq,
                'document_id' => $row->document_id,
                'update_id' => $row->update_id,
                'device_id' => $row->device_id,
                'bytes' => $row->bytes,
            ];
        }

        $cursor = $hasMore
            ? $updates[array_key_last($updates)]['server_seq']
            : max($since, $latestSeq);

        return [
            'updates' => $updates,
            'cursor' => $cursor,
            'latest_seq' => $latestSeq,
            'has_more' => $hasMore,
        ];
    }

    public function latestSeq(Workspace $workspace): int
    {
        return (int) DB::table('document_updates')
            ->where('workspace_id', $workspace->id)
            ->max('server_seq');
    }
}
