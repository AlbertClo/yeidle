import type { Database } from '../../db/database';

/** A node as the page editor loads it: just the fields it renders, nested. */
export type TreeNode = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: unknown;
    is_checked: boolean | null;
    page_type: string | null;
    daily_note_date: string | null;
    children: TreeNode[];
};

type TreeRow = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: string | null;
    is_checked: number | null;
    page_type: string | null;
    daily_note_date: string | null;
};

/** Loads a live node and its live descendants in sibling order, in one query. */
export function loadNodeTree(db: Database, rootId: string): TreeNode {
    const rows = db.all<TreeRow>(
        `WITH RECURSIVE subtree AS (
            SELECT id, parent_id, position, content, tiptap_content, is_checked,
                page_type, daily_note_date
            FROM nodes
            WHERE id = ?
                AND deleted_at IS NULL

            UNION

            SELECT nodes.id, nodes.parent_id, nodes.position, nodes.content,
                nodes.tiptap_content, nodes.is_checked, nodes.page_type,
                nodes.daily_note_date
            FROM nodes
            INNER JOIN subtree ON nodes.parent_id = subtree.id
            WHERE nodes.deleted_at IS NULL
        )
        SELECT *
        FROM subtree
        ORDER BY parent_id, position, id`,
        [rootId],
    );

    let root: TreeNode | null = null;
    const childrenByParent = new Map<string, TreeNode[]>();

    for (const row of rows) {
        const node = nodeFromRow(row);

        if (node.id === rootId) {
            root = node;

            continue;
        }

        const siblings = childrenByParent.get(node.parent_id!) ?? [];
        siblings.push(node);
        childrenByParent.set(node.parent_id!, siblings);
    }

    if (root === null) {
        throw new Error(`Node [${rootId}] was not found.`);
    }

    return attachChildren(root, childrenByParent, new Set());
}

function nodeFromRow(row: TreeRow): TreeNode {
    return {
        id: row.id,
        parent_id: row.parent_id,
        position: row.position,
        content: row.content,
        tiptap_content:
            row.tiptap_content === null ? null : JSON.parse(row.tiptap_content),
        is_checked: row.is_checked === null ? null : Boolean(row.is_checked),
        page_type: row.page_type,
        daily_note_date: row.daily_note_date,
        children: [],
    };
}

// Ancestors guard against parent cycles (possible under concurrent moves)
function attachChildren(
    node: TreeNode,
    childrenByParent: Map<string, TreeNode[]>,
    ancestors: Set<string>,
): TreeNode {
    if (ancestors.has(node.id)) {
        return { ...node, children: [] };
    }

    const inner = new Set(ancestors).add(node.id);

    return {
        ...node,
        children: (childrenByParent.get(node.id) ?? []).map((child) =>
            attachChildren(child, childrenByParent, inner),
        ),
    };
}
