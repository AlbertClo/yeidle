import { placeholders } from '../db/database';
import type { Database } from '../db/database';
import type { DocumentRows, MediaRow, PageRow } from '../loro/projection';
import { canonicalJson } from '../loro/richText';
import { isUuid, uuidv7 } from '../support/ids';
import { modifiedClock, parseTimestamp, sqlTimestamp } from '../support/time';

import { extractMentions } from './linkParser';

/**
 * Writes a document's projected rows into the read model (nodes, node_links,
 * media). Only rows that differ are written; blocks that left the document
 * are soft-deleted. Nothing else writes these tables.
 */

type NodeRow = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: string | null;
    is_checked: number | null;
    page_type: string | null;
    daily_note_date: string | null;
    created_at: string | null;
    deleted_at: string | null;
    document_id: string | null;
};

type NodeData = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: unknown;
    is_checked: boolean | null;
    page_type: string | null;
    daily_note_date: string | null;
    deleted: boolean;
    document_id: string;
};

function sameJson(stored: string | null, value: unknown): boolean {
    if (stored === null || value === null || value === undefined) {
        return stored === null && (value === null || value === undefined);
    }

    try {
        return canonicalJson(JSON.parse(stored)) === canonicalJson(value);
    } catch {
        return false;
    }
}

function differs(old: NodeRow, data: NodeData): boolean {
    return (
        old.parent_id !== data.parent_id ||
        old.position !== data.position ||
        old.content !== data.content ||
        !sameJson(old.tiptap_content, data.tiptap_content) ||
        (old.is_checked === null ? null : old.is_checked === 1) !==
            data.is_checked ||
        old.page_type !== data.page_type ||
        old.daily_note_date !== data.daily_note_date ||
        (old.deleted_at !== null) !== data.deleted ||
        old.document_id !== data.document_id
    );
}

function toSqlTimestamp(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    const date = parseTimestamp(value);

    return date === null ? null : sqlTimestamp(date);
}

export class Projector {
    constructor(private db: Database) {}

    /** Returns whether anything changed. */
    write(documentId: string, rows: DocumentRows): boolean {
        const now = new Date();
        const stamp = sqlTimestamp(now);
        const modified = modifiedClock(now);
        let changed = false;

        for (const media of rows.media) {
            changed = this.writeMedia(media, stamp) || changed;
        }

        if (rows.page === null) {
            return changed;
        }

        const existing = new Map<string, NodeRow>();
        const columns =
            'id, parent_id, position, content, tiptap_content, is_checked, page_type, daily_note_date, created_at, deleted_at, document_id';

        // Two indexed lookups; an OR would scan the table
        for (const row of this.db.all<NodeRow>(
            `SELECT ${columns} FROM nodes WHERE document_id = ?
             UNION SELECT ${columns} FROM nodes WHERE id = ?`,
            [documentId, documentId],
        )) {
            existing.set(row.id, row);
        }

        // Rows from before the document existed, or link shells
        const blockIds = rows.blocks.map((block) => block.id);

        for (let i = 0; i < blockIds.length; i += 500) {
            const chunk = blockIds.slice(i, i + 500);

            for (const row of this.db.all<NodeRow>(
                `SELECT ${columns} FROM nodes WHERE document_id IS NULL AND id IN (${placeholders(chunk.length)})`,
                chunk,
            )) {
                existing.set(row.id, row);
            }
        }

        const page = rows.page;
        const oldPage = existing.get(documentId);

        if (page.has_meta || oldPage !== undefined || rows.blocks.length > 0) {
            const data: NodeData = {
                id: documentId,
                parent_id: null,
                position: 'a0',
                content: page.content,
                tiptap_content: null,
                is_checked: null,
                page_type: page.page_type,
                daily_note_date: page.daily_note_date,
                deleted: page.deleted,
                document_id: documentId,
            };
            const createdAt = this.pageCreatedAt(page, oldPage, stamp);

            if (
                oldPage === undefined ||
                differs(oldPage, data) ||
                oldPage.created_at !== createdAt
            ) {
                this.upsert(data, oldPage, createdAt, stamp, modified);
                changed = true;
            }
        }

        let blocksChanged = false;

        for (const block of rows.blocks) {
            const old = existing.get(block.id);
            const data: NodeData = {
                id: block.id,
                parent_id: block.parent_id,
                position: block.position,
                content: block.content,
                tiptap_content: block.tiptap_content,
                is_checked: block.is_checked,
                page_type: null,
                daily_note_date: null,
                deleted: false,
                document_id: documentId,
            };

            if (old !== undefined && !differs(old, data)) {
                continue;
            }

            const createdAt =
                old?.created_at ?? toSqlTimestamp(block.created_at) ?? stamp;
            this.upsert(data, old, createdAt, stamp, modified);

            if (
                old === undefined ||
                old.deleted_at !== null ||
                !sameJson(old.tiptap_content, block.tiptap_content)
            ) {
                this.rebuildLinks(block.id, block.tiptap_content, stamp);
            }

            blocksChanged = true;
        }

        const live = new Set(blockIds);

        for (const [id, row] of existing) {
            if (
                id === documentId ||
                live.has(id) ||
                row.deleted_at !== null ||
                row.document_id !== documentId
            ) {
                continue;
            }

            this.db.run(
                'UPDATE nodes SET deleted_at = ?, modified_hlc = ?, updated_at = ? WHERE id = ?',
                [stamp, modified, stamp, id],
            );
            blocksChanged = true;
        }

        if (blocksChanged || changed) {
            this.db.run('UPDATE nodes SET modified_hlc = ? WHERE id = ?', [
                modified,
                documentId,
            ]);
        }

        return changed || blocksChanged;
    }

    private upsert(
        data: NodeData,
        old: NodeRow | undefined,
        createdAt: string,
        stamp: string,
        modified: string,
    ): void {
        const values = {
            parent_id: data.parent_id,
            position: data.position,
            content: data.content,
            tiptap_content:
                data.tiptap_content === null ||
                data.tiptap_content === undefined
                    ? null
                    : JSON.stringify(data.tiptap_content),
            is_checked: data.is_checked,
            page_type: data.page_type,
            daily_note_date: data.daily_note_date,
            deleted_at: data.deleted ? (old?.deleted_at ?? stamp) : null,
            document_id: data.document_id,
            created_at: createdAt,
            updated_at: stamp,
            modified_hlc: modified,
        };
        const keys = Object.keys(values) as (keyof typeof values)[];

        if (old === undefined) {
            this.db.run(
                `INSERT INTO nodes (id, purged, ${keys.join(', ')}) VALUES (?, 0, ${placeholders(keys.length)})`,
                [data.id, ...keys.map((key) => values[key])],
            );

            return;
        }

        this.db.run(
            `UPDATE nodes SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`,
            [...keys.map((key) => values[key]), data.id],
        );
    }

    private pageCreatedAt(
        page: PageRow,
        old: NodeRow | undefined,
        stamp: string,
    ): string {
        if (page.page_type === 'daily_note' && page.daily_note_date) {
            return `${page.daily_note_date} 00:00:00`;
        }

        return toSqlTimestamp(page.created_at) ?? old?.created_at ?? stamp;
    }

    /**
     * node_links derives from UUID mentions in the block's content. Targets
     * that don't exist yet get shell rows so the foreign key holds; their
     * own document fills them in later.
     */
    private rebuildLinks(
        nodeId: string,
        tiptapContent: unknown,
        stamp: string,
    ): void {
        this.db.run('DELETE FROM node_links WHERE source_node_id = ?', [
            nodeId,
        ]);

        const links = new Map<string, string | null>();

        for (const mention of extractMentions(tiptapContent)) {
            if (isUuid(mention.id)) {
                links.set(mention.id, mention.label);
            }
        }

        for (const [targetId, label] of [...links].sort(([a], [b]) =>
            a < b ? -1 : 1,
        )) {
            this.db.run(
                `INSERT OR IGNORE INTO nodes (id, content, position, modified_hlc, purged, created_at, updated_at)
                 VALUES (?, '', 'a0', '', 0, ?, ?)`,
                [targetId, stamp, stamp],
            );
            this.db.run(
                `INSERT INTO node_links (id, source_node_id, target_node_id, display_name, created_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [uuidv7(), nodeId, targetId, label, stamp],
            );
        }
    }

    private writeMedia(media: MediaRow, stamp: string): boolean {
        if (
            this.db.get('SELECT 1 FROM media WHERE id = ?', [media.id]) !==
            undefined
        ) {
            return false;
        }

        this.db.run(
            `INSERT INTO media (id, filename, original_name, mime_type, size, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                media.id,
                media.hash,
                media.original_name,
                media.mime_type,
                media.size,
                toSqlTimestamp(media.created_at) ?? stamp,
                stamp,
            ],
        );

        return true;
    }
}
