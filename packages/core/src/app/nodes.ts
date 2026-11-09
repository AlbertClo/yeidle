import type { Database } from '../db/database';
import { jsonTimestamp } from '../support/time';

/**
 * Read helpers for the nodes table (what the PHP app's Node model did).
 * Writes never go through here: content changes go through
 * DocumentService.applyChanges.
 */

export const SystemNodes = {
    PINS_ROOT_ID: '3a647fbb-04a3-512d-bc50-88214e6e14aa',
    PREFERENCES_ROOT_ID: 'a80584ce-bfc0-537d-b1fd-a76e68f1a949',
    COLLAPSED_NODES_ROOT_ID: 'cb358d9c-f818-406a-bce5-0e4c78b72b13',
    get ROOT_IDS(): string[] {
        return [
            this.PINS_ROOT_ID,
            this.PREFERENCES_ROOT_ID,
            this.COLLAPSED_NODES_ROOT_ID,
        ];
    },
    isRoot(id: string): boolean {
        return this.ROOT_IDS.includes(id);
    },
};

/** A nodes row as stored. */
export type NodeRow = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    is_checked: number | null;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
    tiptap_content: string | null;
    field_clocks?: string | null;
    purged: number;
    modified_hlc: string;
    page_type: string | null;
    daily_note_date: string | null;
    document_id: string | null;
};

/** A node as the frontend receives it (Laravel's model serialization). */
export type NodeJson = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    is_checked: boolean | null;
    created_at: string | null;
    updated_at: string | null;
    deleted_at: string | null;
    tiptap_content: unknown;
    modified_hlc: string;
    page_type: string | null;
    daily_note_date: string | null;
    document_id: string | null;
    children?: NodeJson[];
};

export function serializeNode(row: NodeRow): NodeJson {
    return {
        id: row.id,
        parent_id: row.parent_id,
        position: row.position,
        content: row.content,
        is_checked: row.is_checked === null ? null : Boolean(row.is_checked),
        created_at: jsonTimestamp(row.created_at),
        updated_at: jsonTimestamp(row.updated_at),
        deleted_at: jsonTimestamp(row.deleted_at),
        tiptap_content:
            row.tiptap_content === null ? null : JSON.parse(row.tiptap_content),
        modified_hlc: row.modified_hlc,
        page_type: row.page_type,
        daily_note_date: row.daily_note_date,
        document_id: row.document_id,
    };
}

export function findNode(
    db: Database,
    id: string,
    options: { withTrashed?: boolean } = {},
): NodeRow | null {
    const row = db.get<NodeRow>(
        options.withTrashed
            ? 'SELECT * FROM nodes WHERE id = ?'
            : 'SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL',
        [id],
    );

    return row ?? null;
}

/** Live children in sibling order. */
export function childrenOf(db: Database, parentId: string): NodeRow[] {
    return db.all<NodeRow>(
        'SELECT * FROM nodes WHERE parent_id = ? AND deleted_at IS NULL ORDER BY position, id',
        [parentId],
    );
}

export function isPage(row: NodeRow): boolean {
    return row.parent_id === null;
}

export function isDailyNote(row: NodeRow): boolean {
    return row.page_type === 'daily_note' && row.daily_note_date !== null;
}

/** Whether a node belongs to one of the hidden system subtrees. */
export function isSystemNode(db: Database, row: NodeRow): boolean {
    const visited = new Set<string>();
    let node: NodeRow | null = row;

    while (node !== null) {
        if (SystemNodes.isRoot(node.id)) {
            return true;
        }

        if (node.parent_id === null || visited.has(node.id)) {
            return false;
        }

        visited.add(node.id);
        node = findNode(db, node.parent_id, { withTrashed: true });
    }

    return false;
}

/** Whether the node and every ancestor are live (deletions don't cascade in storage). */
export function isReachable(db: Database, row: NodeRow): boolean {
    const visited = new Set<string>();
    let node: NodeRow | null = row;

    while (node !== null) {
        if (node.purged || node.deleted_at !== null) {
            return false;
        }

        if (node.parent_id === null) {
            return true;
        }

        if (visited.has(node.id)) {
            return false;
        }

        visited.add(node.id);
        node = findNode(db, node.parent_id, { withTrashed: true });
    }

    return false;
}

/** SQL for live, user-visible top-level pages (excludes system roots). */
export const LIVE_PAGES_SQL = `parent_id IS NULL AND deleted_at IS NULL AND id NOT IN ('${SystemNodes.PINS_ROOT_ID}', '${SystemNodes.PREFERENCES_ROOT_ID}', '${SystemNodes.COLLAPSED_NODES_ROOT_ID}')`;
