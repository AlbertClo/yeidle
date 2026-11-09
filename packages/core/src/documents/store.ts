import type { Database } from '../db/database';
import { uuidv7 } from '../support/ids';
import { sqlTimestamp } from '../support/time';

/**
 * Storage for Loro documents: a compacted snapshot per document plus the
 * append-only update log. The update's local sequence is its row id;
 * cloud_seq marks updates the cloud already has (NULL = cloud outbox).
 */

export type StoredDocument = {
    id: string;
    snapshot: Uint8Array | null;
    updates: Uint8Array[];
    seq: number;
};

export type StoredUpdate = { seq: number; client_id: string; bytes: Uint8Array };

export class DocumentStore {
    constructor(private db: Database) {}

    /** Creates the document row if it doesn't exist yet. */
    ensure(documentId: string): void {
        this.db.run(
            'INSERT OR IGNORE INTO documents (id, snapshot_seq, updated_at) VALUES (?, 0, ?)',
            [documentId, sqlTimestamp()],
        );
    }

    exists(documentId: string): boolean {
        return this.db.get('SELECT 1 FROM documents WHERE id = ?', [documentId]) !== undefined;
    }

    load(documentId: string): StoredDocument {
        const document = this.db.get<{ snapshot: Uint8Array | null; snapshot_seq: number }>(
            'SELECT snapshot, snapshot_seq FROM documents WHERE id = ?',
            [documentId],
        );
        const snapshotSeq = document?.snapshot_seq ?? 0;
        const updates = this.db.all<{ id: number; bytes: Uint8Array }>(
            'SELECT id, bytes FROM document_updates WHERE document_id = ? AND id > ? ORDER BY id',
            [documentId, snapshotSeq],
        );

        return {
            id: documentId,
            snapshot: document?.snapshot && document.snapshot.length > 0 ? document.snapshot : null,
            updates: updates.map((row) => row.bytes),
            seq: Math.max(snapshotSeq, this.latestSeq(documentId)),
        };
    }

    latestSeq(documentId: string): number {
        return (
            this.db.get<{ seq: number | null }>(
                'SELECT MAX(id) AS seq FROM document_updates WHERE document_id = ?',
                [documentId],
            )?.seq ?? 0
        );
    }

    hasUpdate(updateId: string): boolean {
        return (
            this.db.get('SELECT 1 FROM document_updates WHERE update_id = ?', [updateId]) !==
            undefined
        );
    }

    /** Appends an update. Returns its local sequence. */
    append(
        documentId: string,
        bytes: Uint8Array,
        clientId: string,
        updateId: string = uuidv7(),
        cloudSeq: number | null = null,
    ): number {
        return this.db.run(
            `INSERT INTO document_updates (document_id, update_id, client_id, bytes, cloud_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [documentId, updateId, clientId, bytes, cloudSeq, sqlTimestamp()],
        ).lastInsertRowid;
    }

    saveSnapshot(documentId: string, snapshot: Uint8Array, seq: number): void {
        this.db.run('UPDATE documents SET snapshot = ?, snapshot_seq = ?, updated_at = ? WHERE id = ?', [
            snapshot,
            seq,
            sqlTimestamp(),
            documentId,
        ]);
    }

    /** Number of updates not yet folded into the snapshot. */
    pendingUpdates(documentId: string): number {
        return (
            this.db.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM document_updates
                 WHERE document_id = ? AND id > (SELECT snapshot_seq FROM documents WHERE id = ?)`,
                [documentId, documentId],
            )?.count ?? 0
        );
    }

    updatesSince(documentId: string, since: number): StoredUpdate[] {
        return this.db
            .all<{ id: number; client_id: string; bytes: Uint8Array }>(
                'SELECT id, client_id, bytes FROM document_updates WHERE document_id = ? AND id > ? ORDER BY id',
                [documentId, since],
            )
            .map((row) => ({ seq: row.id, client_id: row.client_id, bytes: row.bytes }));
    }

    /** Which documents changed after a local sequence. */
    changesSince(since: number): { documents: { id: string; seq: number }[]; seq: number } {
        const rows = this.db.all<{ document_id: string; seq: number }>(
            'SELECT document_id, MAX(id) AS seq FROM document_updates WHERE id > ? GROUP BY document_id',
            [since],
        );
        const latest =
            this.db.get<{ seq: number | null }>('SELECT MAX(id) AS seq FROM document_updates')?.seq ?? 0;

        return {
            documents: rows.map((row) => ({ id: row.document_id, seq: row.seq })),
            seq: Math.max(since, latest),
        };
    }
}
