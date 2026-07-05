import type { Node } from '@/types/node';

import type { Op } from './ops';

/**
 * Applies remote ops to the client-side page tree (the `pageNodes`
 * structure Show.vue feeds the editor). Pure data surgery — the caller
 * decides how to reflect the result in the live editor.
 *
 * Change severity drives that decision:
 * - 'none'       nothing in this page changed
 * - 'content'    only content/tiptap_content/is_checked of existing nodes
 *                changed — targeted editor updates suffice
 * - 'structural' nodes were added, removed, or moved — the editor needs a
 *                structural refresh
 */
export type TreeChange = 'none' | 'content' | 'structural';

type Located = { node: Node; siblings: Node[]; index: number };

function locate(roots: Node[], id: string): Located | null {
    const stack: Node[][] = [roots];

    while (stack.length > 0) {
        const siblings = stack.pop()!;

        for (let i = 0; i < siblings.length; i++) {
            if (siblings[i].id === id) {
                return { node: siblings[i], siblings, index: i };
            }

            if (siblings[i].children?.length) {
                stack.push(siblings[i].children!);
            }
        }
    }

    return null;
}

function insertByPosition(siblings: Node[], node: Node): void {
    const at = siblings.findIndex((s) => s.position > node.position);

    if (at === -1) {
        siblings.push(node);
    } else {
        siblings.splice(at, 0, node);
    }
}

const CONTENT_FIELDS = ['content', 'tiptap_content', 'is_checked'] as const;

function applyNodeSet(roots: Node[], pageId: string, op: Op): TreeChange {
    const payload = op.payload as {
        id: string;
        fields: Partial<Node> & Record<string, unknown>;
    };
    const fields = payload.fields;
    const found = locate(roots, payload.id);

    if (!found) {
        // New node. Its parent must already be in the tree (ops arrive in
        // log order, parents-first); otherwise it belongs to a subtree this
        // page can't see and is safely ignored.
        const parentId = (fields.parent_id as string | null) ?? null;
        const siblings =
            parentId === pageId
                ? roots
                : ((parentId && locate(roots, parentId)?.node.children) ??
                  null);

        if (!siblings) {
            return 'none';
        }

        const node: Node = {
            id: payload.id,
            parent_id: parentId,
            position: (fields.position as string) ?? 'a0',
            content: (fields.content as string) ?? '',
            tiptap_content:
                (fields.tiptap_content as Node['tiptap_content']) ?? null,
            is_checked: (fields.is_checked as boolean | null) ?? null,
            created_at: '',
            updated_at: '',
            children: [],
        };
        insertByPosition(siblings, node);

        return 'structural';
    }

    let change: TreeChange = 'none';
    const { node } = found;

    for (const field of CONTENT_FIELDS) {
        if (field in fields) {
            (node as any)[field] = fields[field] ?? null;

            if (field === 'content' && node.content === null) {
                node.content = '';
            }

            change = 'content';
        }
    }

    const moved =
        ('parent_id' in fields && fields.parent_id !== node.parent_id) ||
        ('position' in fields && fields.position !== node.position);

    if (moved) {
        found.siblings.splice(found.index, 1);

        if ('parent_id' in fields) {
            node.parent_id = (fields.parent_id as string | null) ?? null;
        }

        if ('position' in fields) {
            node.position = (fields.position as string) ?? node.position;
        }

        const siblings =
            node.parent_id === pageId
                ? roots
                : (node.parent_id &&
                      locate(roots, node.parent_id)?.node.children) ||
                  null;

        if (siblings) {
            insertByPosition(siblings, node);
        }
        // If the new parent isn't visible on this page the node just leaves
        // the tree — matches derived reachability

        return 'structural';
    }

    return change;
}

function applyNodeDelete(roots: Node[], op: Op): TreeChange {
    const found = locate(roots, (op.payload as { id: string }).id);

    if (!found) {
        return 'none';
    }

    // Removing the item removes its nested children with it — the visible
    // equivalent of derived subtree reachability
    found.siblings.splice(found.index, 1);

    return 'structural';
}

/**
 * Applies ops in order and returns the most severe change, plus the ids of
 * nodes whose content changed (for targeted editor updates).
 */
export function applyOpsToTree(
    roots: Node[],
    pageId: string,
    ops: Op[],
): { change: TreeChange; contentChanged: string[] } {
    let change: TreeChange = 'none';
    const contentChanged = new Set<string>();

    for (const op of ops) {
        let result: TreeChange = 'none';

        if (op.type === 'node.set') {
            result = applyNodeSet(roots, pageId, op);

            if (result === 'content') {
                contentChanged.add((op.payload as { id: string }).id);
            }
        } else if (op.type === 'node.delete') {
            result = applyNodeDelete(roots, op);
        }

        if (
            result === 'structural' ||
            (result === 'content' && change === 'none')
        ) {
            change = result;
        }
    }

    return { change, contentChanged: [...contentChanged] };
}

/** The node (if any) in the tree that contains the given id. */
export function findInTree(roots: Node[], id: string): Node | null {
    return locate(roots, id)?.node ?? null;
}
