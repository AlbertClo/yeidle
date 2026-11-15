import type { Database } from '../db/database';
import { uuidv7 } from '../support/ids';

/**
 * Storage for Loro documents: a compacted snapshot per document plus the
 * append-only update log. Each update has a local sequence (seq);
 * cloud_seq marks updates the cloud already has (NULL = cloud outbox).
 */

export type StoredDocument = {
    id: string;
    snapshot: Uint8Array | null;
    updates: Uint8Array[];
    seq: number;
};

export type StoredUpdate = {
    seq: number;
    origin: string;
    bytes: Uint8Array;
};

export class DocumentStore {
    constructor(private db: Database) {}

    /** Creates the document row if it doesn't exist yet. */
    ensure(documentId: string): void {
        this.db.run('INSERT OR IGNORE INTO documents (id) VALUES (?)', [
            documentId,
        ]);
    }

    exists(documentId: string): boolean {
        return (
            this.db.get('SELECT 1 FROM documents WHERE id = ?', [
                documentId,
            ]) !== undefined
        );
    }

    /** Every stored document id. */
    ids(): string[] {
        return this.db
            .all<{ id: string }>('SELECT id FROM documents ORDER BY id')
            .map((row) => row.id);
    }

    load(documentId: string): StoredDocument {
        const document = this.db.get<{
            snapshot: Uint8Array | null;
            snapshot_seq: number;
        }>('SELECT snapshot, snapshot_seq FROM documents WHERE id = ?', [
            documentId,
        ]);
        const snapshotSeq = document?.snapshot_seq ?? 0;
        const updates = this.db.all<{ bytes: Uint8Array }>(
            'SELECT bytes FROM document_updates WHERE document_id = ? AND seq > ? ORDER BY seq',
            [documentId, snapshotSeq],
        );

        return {
            id: documentId,
            snapshot:
                document?.snapshot && document.snapshot.length > 0
                    ? document.snapshot
                    : null,
            updates: updates.map((row) => row.bytes),
            seq: Math.max(snapshotSeq, this.latestSeq(documentId)),
        };
    }

    latestSeq(documentId: string): number {
        return (
            this.db.get<{ seq: number | null }>(
                'SELECT MAX(seq) AS seq FROM document_updates WHERE document_id = ?',
                [documentId],
            )?.seq ?? 0
        );
    }

    hasUpdate(updateId: string): boolean {
        return (
            this.db.get('SELECT 1 FROM document_updates WHERE update_id = ?', [
                updateId,
            ]) !== undefined
        );
    }

    /** Appends an update. Returns its local sequence. */
    append(
        documentId: string,
        bytes: Uint8Array,
        origin: string,
        updateId: string = uuidv7(),
        cloudSeq: number | null = null,
    ): number {
        return this.db.run(
            `INSERT INTO document_updates (document_id, update_id, origin, bytes, cloud_seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [documentId, updateId, origin, bytes, cloudSeq, Date.now()],
        ).lastInsertRowid;
    }

    saveSnapshot(documentId: string, snapshot: Uint8Array, seq: number): void {
        this.db.run(
            'UPDATE documents SET snapshot = ?, snapshot_seq = ? WHERE id = ?',
            [snapshot, seq, documentId],
        );
    }

    /** Number of updates not yet folded into the snapshot. */
    pendingUpdates(documentId: string): number {
        return (
            this.db.get<{ count: number }>(
                `SELECT COUNT(*) AS count FROM document_updates
                 WHERE document_id = ? AND seq > (SELECT snapshot_seq FROM documents WHERE id = ?)`,
                [documentId, documentId],
            )?.count ?? 0
        );
    }

    updatesSince(documentId: string, since: number): StoredUpdate[] {
        return this.db.all<StoredUpdate>(
            'SELECT seq, origin, bytes FROM document_updates WHERE document_id = ? AND seq > ? ORDER BY seq',
            [documentId, since],
        );
    }

    /** Which documents changed after a local sequence. */
    changesSince(since: number): {
        documents: { id: string; seq: number }[];
        seq: number;
    } {
        const rows = this.db.all<{ document_id: string; seq: number }>(
            'SELECT document_id, MAX(seq) AS seq FROM document_updates WHERE seq > ? GROUP BY document_id',
            [since],
        );
        const latest =
            this.db.get<{ seq: number | null }>(
                'SELECT MAX(seq) AS seq FROM document_updates',
            )?.seq ?? 0;

        return {
            documents: rows.map((row) => ({
                id: row.document_id,
                seq: row.seq,
            })),
            seq: Math.max(since, latest),
        };
    }
}
