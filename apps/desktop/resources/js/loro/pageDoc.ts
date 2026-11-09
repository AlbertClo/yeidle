import { generateNKeysBetween } from 'fractional-indexing';
import { LoroDoc, LoroText } from 'loro-crdt';
import type { LoroTree, LoroTreeNode, TreeID } from 'loro-crdt';
import { uuidv7 } from 'uuidv7';

import { blocksPlainText } from '../editor/nodeText';

import {
    applyUnits,
    configureTextStyles,
    contentToUnits,
    readUnits,
    unitsToContent,
} from './richText';
import type { TiptapContent } from './richText';

/**
 * A page's blocks as one Loro document: a movable tree whose nodes carry the
 * block id, rich text, and checkbox state. The page itself is not a tree node —
 * top-level blocks are the tree roots, and their parent_id is the page id.
 */

export const BLOCKS = 'blocks';

/** The editor/projection shape of a block (mirrors the nodes table). */
export type Block = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: TiptapContent;
    is_checked: boolean | null;
    created_at?: string;
    children?: Block[];
};

export function createDoc(): LoroDoc {
    const doc = new LoroDoc();
    configureTextStyles(doc);
    doc.setRecordTimestamp(true);

    return doc;
}

export function blocksTree(doc: LoroDoc): LoroTree {
    const tree = doc.getTree(BLOCKS);

    if (!tree.isFractionalIndexEnabled()) {
        tree.enableFractionalIndex(0);
    }

    return tree;
}

function blockId(node: LoroTreeNode): string | undefined {
    const id = node.data.get('id');

    return typeof id === 'string' ? id : undefined;
}

function blockText(node: LoroTreeNode): LoroText {
    const existing = node.data.get('text');

    if (existing instanceof LoroText) {
        return existing;
    }

    return node.data.setContainer('text', new LoroText());
}

function blockChecked(node: LoroTreeNode): boolean | null {
    const checked = node.data.get('checked');

    return typeof checked === 'boolean' ? checked : null;
}

function children(tree: LoroTree, parent: LoroTreeNode | null): LoroTreeNode[] {
    return parent === null ? tree.roots() : (parent.children() ?? []);
}

/** Every live block by id, in document order. Later duplicates are listed separately. */
function indexBlocks(tree: LoroTree): {
    byId: Map<string, LoroTreeNode>;
    duplicates: LoroTreeNode[];
} {
    const byId = new Map<string, LoroTreeNode>();
    const duplicates: LoroTreeNode[] = [];

    const visit = (nodes: LoroTreeNode[]) => {
        for (const node of nodes) {
            const id = blockId(node);

            if (id === undefined || byId.has(id)) {
                duplicates.push(node);
            } else {
                byId.set(id, node);
            }

            visit(node.children() ?? []);
        }
    };

    visit(tree.roots());

    return { byId, duplicates };
}

/** Longest increasing subsequence of `values`, returned as a set of indices. */
function longestIncreasing(values: number[]): Set<number> {
    const tails: number[] = [];
    const previous = new Array<number>(values.length).fill(-1);

    for (let i = 0; i < values.length; i++) {
        let lo = 0;
        let hi = tails.length;

        while (lo < hi) {
            const mid = (lo + hi) >> 1;

            if (values[tails[mid]] < values[i]) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }

        previous[i] = lo > 0 ? tails[lo - 1] : -1;
        tails[lo] = i;
    }

    const result = new Set<number>();
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;

    while (k !== -1) {
        result.add(k);
        k = previous[k];
    }

    return result;
}

export type ApplyOptions = {
    /** Skip comparing content for blocks this returns false for. */
    contentChanged?: (block: Block) => boolean;
    now?: () => string;
};

/**
 * Makes the document's tree equal `blocks` (the full nested block list of the
 * page) with the fewest operations: blocks that kept their place are left
 * alone, so concurrent edits elsewhere merge cleanly. Returns whether the
 * document changed. The caller commits.
 */
export function applyBlocks(
    doc: LoroDoc,
    blocks: Block[],
    options: ApplyOptions = {},
): boolean {
    const tree = blocksTree(doc);
    const { byId, duplicates } = indexBlocks(tree);
    let changed = false;

    // A block id can only appear once. Duplicates (a concurrent re-creation)
    // become independent blocks so neither side's content is lost.
    for (const node of duplicates) {
        node.data.set('id', uuidv7());
        changed = true;
    }

    const desiredParent = new Map<string, string | null>();

    const collect = (list: Block[], parent: string | null) => {
        for (const block of list) {
            desiredParent.set(block.id, parent);
            collect(block.children ?? [], block.id);
        }
    };
    collect(blocks, null);

    const now = options.now ?? (() => new Date().toISOString());
    const created = new Set<string>();

    const place = (list: Block[], parentId: string | null) => {
        const parent = parentId === null ? null : byId.get(parentId)!;
        const desiredIndex = new Map(list.map((block, i) => [block.id, i]));
        const current = children(tree, parent)
            .map((node) => blockId(node))
            .filter(
                (id): id is string =>
                    id !== undefined &&
                    desiredIndex.has(id) &&
                    desiredParent.get(id) === parentId,
            );
        const keepIndices = longestIncreasing(
            current.map((id) => desiredIndex.get(id)!),
        );
        const keep = new Set([...keepIndices].map((i) => current[i]));

        for (let i = 0; i < list.length; i++) {
            const block = list[i];

            if (keep.has(block.id)) {
                continue;
            }

            const previous = i > 0 ? byId.get(list[i - 1].id)! : null;
            const existing = byId.get(block.id);
            const parentTreeId: TreeID | undefined = parent?.id;

            if (existing && previous) {
                existing.moveAfter(previous);
            } else if (existing) {
                tree.move(existing.id, parentTreeId, 0);
            } else {
                const index = previous === null ? 0 : previous.index()! + 1;
                const node = tree.createNode(parentTreeId, index);
                node.data.set('id', block.id);
                node.data.set('created_at', block.created_at || now());
                byId.set(block.id, node);
                created.add(block.id);
            }

            changed = true;
        }

        for (const block of list) {
            const node = byId.get(block.id)!;

            if (blockChecked(node) !== (block.is_checked ?? null)) {
                if (block.is_checked === null || block.is_checked === undefined) {
                    node.data.delete('checked');
                } else {
                    node.data.set('checked', block.is_checked);
                }

                changed = true;
            }

            if (
                options.contentChanged === undefined ||
                created.has(block.id) ||
                options.contentChanged(block)
            ) {
                if (
                    applyUnits(
                        blockText(node),
                        contentToUnits(block.tiptap_content),
                    )
                ) {
                    changed = true;
                }
            }

            place(block.children ?? [], block.id);
        }
    };

    place(blocks, null);

    // Delete the top-most of each removed subtree; anything that moved out
    // of it was relocated above
    for (const [id, node] of byId) {
        if (desiredParent.has(id) || tree.isNodeDeleted(node.id)) {
            continue;
        }

        const parent = node.parent();
        const parentId = parent ? blockId(parent) : undefined;

        if (parentId === undefined || desiredParent.has(parentId)) {
            tree.delete(node.id);
            changed = true;
        }
    }

    // Removed blocks nested under other removed blocks went with them
    return changed;
}

function readBlock(node: LoroTreeNode, id: string, parentId: string): Block {
    const text = node.data.get('text');
    const content = unitsToContent(
        text instanceof LoroText ? readUnits(text) : [],
    );
    const created = node.data.get('created_at');
    const blocks = content === null ? [] : Array.isArray(content) ? content : [content];

    return {
        id,
        parent_id: parentId,
        position: '',
        content: blocksPlainText(blocks as Record<string, unknown>[]),
        tiptap_content: content,
        is_checked: blockChecked(node),
        created_at: typeof created === 'string' ? created : undefined,
    };
}

/** The nested block list of the page, as the editor consumes it. */
export function readBlocks(doc: LoroDoc, pageId: string): Block[] {
    const tree = blocksTree(doc);
    const seen = new Set<string>();

    // Pre-order, matching indexBlocks: the first occurrence of an id wins
    const build = (nodes: LoroTreeNode[], parentId: string): Block[] => {
        const list: Block[] = [];

        for (const node of nodes) {
            const id = blockId(node);

            if (id === undefined || seen.has(id)) {
                continue;
            }

            seen.add(id);
            list.push({
                ...readBlock(node, id, parentId),
                children: build(node.children() ?? [], id),
            });
        }

        const positions =
            list.length > 0 ? generateNKeysBetween(null, null, list.length) : [];
        list.forEach((block, i) => (block.position = positions[i]));

        return list;
    };

    return build(tree.roots(), pageId);
}

/** Flat rows for the nodes projection (pre-order, parents first). */
export function flattenBlocks(blocks: Block[]): Block[] {
    const rows: Block[] = [];

    const visit = (list: Block[]) => {
        for (const block of list) {
            const { children: nested, ...row } = block;
            rows.push(row);
            visit(nested ?? []);
        }
    };

    visit(blocks);

    return rows;
}
