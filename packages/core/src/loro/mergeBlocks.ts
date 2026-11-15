import type { LoroDoc } from 'loro-crdt';

import { applyBlocks, readBlocks } from './pageDoc';
import type { Block } from './pageDoc';
import type { TiptapContent } from './richText';

/**
 * Adds or updates blocks of a page by id, keeping every other block where it
 * is (the Roam import into an existing page). The rows are applied to a copy
 * of the page's block tree, which is then written with applyBlocks, so the
 * write takes the same minimal-diff path as the editor.
 */

export type BlockInput = {
    id: string;
    /** The parent block, or the page id for a top-level block. */
    parent_id: string;
    /** Orders siblings within this merge (fractional index). */
    position: string;
    tiptap_content: TiptapContent;
    is_checked: boolean | null;
    created_at?: string | null;
};

function compareSiblings(a: Block, b: Block): number {
    if (a.position !== b.position) {
        return a.position < b.position ? -1 : 1;
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function insertSorted(siblings: Block[], block: Block): void {
    const at = siblings.findIndex(
        (sibling) => compareSiblings(block, sibling) < 0,
    );

    if (at === -1) {
        siblings.push(block);
    } else {
        siblings.splice(at, 0, block);
    }
}

/**
 * Merges blocks into one page document. Returns whether the document
 * changed. The caller commits.
 */
export function mergeBlocks(
    doc: LoroDoc,
    pageId: string,
    rows: BlockInput[],
): boolean {
    const roots = readBlocks(doc, pageId);
    const byId = new Map<string, Block>();

    const index = (list: Block[]) => {
        for (const block of list) {
            byId.set(block.id, block);
            index(block.children ?? []);
        }
    };
    index(roots);

    const siblingsOf = (parentId: string | null): Block[] | null => {
        if (parentId === null || parentId === pageId) {
            return roots;
        }

        const parent = byId.get(parentId);

        if (!parent) {
            return null;
        }

        parent.children ??= [];

        return parent.children;
    };

    const detach = (block: Block) => {
        const siblings = siblingsOf(block.parent_id);
        const at = siblings?.indexOf(block) ?? -1;

        if (at !== -1) {
            siblings!.splice(at, 1);
        }
    };

    // Blocks whose parent hasn't been seen yet (children before parents)
    const orphans: Block[] = [];

    const attach = (block: Block) => {
        const siblings = siblingsOf(block.parent_id);

        if (siblings === null) {
            orphans.push(block);
        } else {
            insertSorted(siblings, block);
        }
    };

    for (const row of rows) {
        let block = byId.get(row.id);

        if (!block) {
            block = {
                id: row.id,
                parent_id: row.parent_id,
                position: row.position,
                content: '',
                tiptap_content: null,
                is_checked: null,
                created_at: row.created_at ?? undefined,
                children: [],
            };
            byId.set(row.id, block);
            attach(block);
        } else {
            detach(block);
            block.parent_id = row.parent_id;
            block.position = row.position;
            attach(block);
        }

        block.tiptap_content = row.tiptap_content;
        block.is_checked = row.is_checked;
    }

    // Parents created later in the same merge adopt their children; anything
    // still orphaned keeps its content at the end of the page
    for (let progress = true; progress && orphans.length > 0;) {
        progress = false;

        for (const orphan of [...orphans]) {
            const siblings = siblingsOf(orphan.parent_id);

            if (siblings !== null) {
                orphans.splice(orphans.indexOf(orphan), 1);
                insertSorted(siblings, orphan);
                progress = true;
            }
        }
    }

    for (const orphan of orphans) {
        orphan.parent_id = pageId;
        roots.push(orphan);
    }

    const merged = new Set(rows.map((row) => row.id));

    return applyBlocks(doc, roots, {
        contentChanged: (block) => merged.has(block.id),
    });
}
