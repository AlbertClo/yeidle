import type { Database } from '../db/database';
import type { Block } from '../loro/pageDoc';

import type { DocumentAction, DocumentService } from './service';
import { MEDIA_DOCUMENT_ID } from './service';

/**
 * One-time conversion of a workspace written by the op-log sync engine (the
 * NativePHP app): every top-level node becomes a page document holding its
 * live subtree, and media metadata moves into the media document. Re-running
 * after a partial failure converts only what is still missing.
 */

const DOCUMENTS_PER_WRITE = 100;
const MESSAGE = 'Migrated from the previous sync engine';

type LegacyNode = {
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
};

export function legacyMigrationNeeded(db: Database): boolean {
    return (
        db.get('SELECT 1 FROM documents LIMIT 1') === undefined &&
        db.get('SELECT 1 FROM nodes WHERE purged = 0 LIMIT 1') !== undefined
    );
}

/** Returns the number of page documents created. */
export function runLegacyMigration(
    db: Database,
    documents: DocumentService,
    progress?: (done: number, total: number) => void,
): number {
    const media = db.all<{
        id: string;
        filename: string;
        original_name: string;
        mime_type: string;
        size: number;
        created_at: string | null;
    }>(
        'SELECT id, filename, original_name, mime_type, size, created_at FROM media ORDER BY id',
    );

    if (media.length > 0) {
        documents.apply(
            [
                {
                    document_id: MEDIA_DOCUMENT_ID,
                    media: media.map((row) => ({
                        id: row.id,
                        hash: row.filename,
                        original_name: row.original_name,
                        mime_type: row.mime_type,
                        size: Number(row.size),
                        created_at: row.created_at,
                    })),
                },
            ],
            MESSAGE,
        );
    }

    const nodes = db.all<LegacyNode>(
        `SELECT id, parent_id, position, content, tiptap_content, is_checked, page_type,
                daily_note_date, created_at, deleted_at
         FROM nodes WHERE purged = 0 ORDER BY position, id`,
    );
    const children = new Map<string, LegacyNode[]>();

    for (const node of nodes) {
        if (node.parent_id !== null) {
            const list = children.get(node.parent_id) ?? [];
            list.push(node);
            children.set(node.parent_id, list);
        }
    }

    const converted = new Set(
        db.all<{ id: string }>('SELECT id FROM documents').map((row) => row.id),
    );
    const pages = nodes.filter(
        (node) =>
            node.parent_id === null &&
            !converted.has(node.id) &&
            // Rows created only to satisfy a link's foreign key
            !(
                node.content === '' &&
                node.page_type === null &&
                !children.has(node.id)
            ),
    );

    const subtree = (parentId: string): Block[] =>
        (children.get(parentId) ?? [])
            .filter((row) => row.deleted_at === null)
            .map((row) => ({
                id: row.id,
                parent_id: parentId,
                position: String(row.position),
                content: row.content,
                tiptap_content:
                    row.tiptap_content !== null
                        ? JSON.parse(row.tiptap_content)
                        : row.content === ''
                          ? null
                          : {
                                type: 'paragraph',
                                content: [{ type: 'text', text: row.content }],
                            },
                is_checked:
                    row.is_checked === null ? null : row.is_checked === 1,
                created_at: row.created_at ?? undefined,
                children: subtree(row.id),
            }));

    let count = 0;

    for (let i = 0; i < pages.length; i += DOCUMENTS_PER_WRITE) {
        const actions: DocumentAction[] = pages
            .slice(i, i + DOCUMENTS_PER_WRITE)
            .map((page) => ({
                document_id: page.id,
                replace: {
                    page: {
                        title: page.content,
                        page_type:
                            page.page_type === 'daily_note'
                                ? 'daily_note'
                                : null,
                        daily_note_date: page.daily_note_date,
                        created_at: page.created_at,
                        deleted: page.deleted_at !== null,
                    },
                    blocks: subtree(page.id),
                },
            }));
        count += documents.apply(actions, MESSAGE).length;
        progress?.(
            Math.min(i + DOCUMENTS_PER_WRITE, pages.length),
            pages.length,
        );
    }

    return count;
}
