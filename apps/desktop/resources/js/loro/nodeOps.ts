import type { LoroDoc } from 'loro-crdt';

import { applyBlocks, readBlocks } from './pageDoc';
import type { Block } from './pageDoc';
import { updatePageMeta } from './pageMeta';
import type { PageMeta } from './pageMeta';
import type { TiptapContent } from './richText';

/**
 * Node-level changes in the shape the rest of the app already speaks
 * (`node.set` with changed fields, `node.delete`). They are applied to a copy
 * of the page's block tree, which is then written to the document with
 * applyBlocks — so every write takes the same minimal-diff path as the editor.
 */

export type NodeChange =
    | {
          type: 'node.set';
          payload: {
              id: string;
              page_id: string;
              fields: Record<string, unknown>;
          };
      }
    | {
          type: 'node.delete' | 'node.purge';
          payload: { id: string; page_id: string };
      };

function compareSiblings(a: Block, b: Block): number {
    if (a.position !== b.position) {
        return a.position < b.position ? -1 : 1;
    }

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function insertSorted(siblings: Block[], block: Block): void {
    const at = siblings.findIndex((sibling) => compareSiblings(block, sibling) < 0);

    if (at === -1) {
        siblings.push(block);
    } else {
        siblings.splice(at, 0, block);
    }
}

function paragraph(text: string): TiptapContent {
    return text === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text }] };
}

/**
 * Applies node changes for one page document. Changes to the page node itself
 * update the page fields; changes to other nodes edit the block tree.
 * Returns whether the document changed. The caller commits.
 */
export function applyNodeChanges(
    doc: LoroDoc,
    pageId: string,
    changes: NodeChange[],
): boolean {
    let changed = false;
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

    // Blocks whose parent hasn't been seen yet (out-of-order batches)
    const orphans: Block[] = [];

    const attach = (block: Block) => {
        const siblings = siblingsOf(block.parent_id);

        if (siblings === null) {
            orphans.push(block);
        } else {
            insertSorted(siblings, block);
        }
    };

    const touched = new Set<string>();
    let treeChanged = false;

    for (const change of changes) {
        const { id } = change.payload;

        if (id === pageId) {
            if (change.type === 'node.set') {
                const fields = change.payload.fields;
                const meta: Partial<PageMeta> = { deleted: false };

                if ('content' in fields) {
                    meta.title = String(fields.content ?? '');
                }

                if ('page_type' in fields) {
                    meta.page_type = fields.page_type === 'daily_note' ? 'daily_note' : null;
                }

                if ('daily_note_date' in fields) {
                    meta.daily_note_date =
                        typeof fields.daily_note_date === 'string'
                            ? fields.daily_note_date
                            : null;
                }

                if ('created_at' in fields && typeof fields.created_at === 'string') {
                    meta.created_at = fields.created_at;
                }

                changed = updatePageMeta(doc, meta) || changed;
            } else {
                changed = updatePageMeta(doc, { deleted: true }) || changed;
            }

            continue;
        }

        if (change.type !== 'node.set') {
            const block = byId.get(id);

            if (block) {
                detach(block);

                const forget = (b: Block) => {
                    byId.delete(b.id);
                    (b.children ?? []).forEach(forget);
                };
                forget(block);
                treeChanged = true;
            }

            continue;
        }

        const fields = change.payload.fields;
        let block = byId.get(id);

        if (!block) {
            block = {
                id,
                parent_id:
                    typeof fields.parent_id === 'string' ? fields.parent_id : pageId,
                position: typeof fields.position === 'string' ? fields.position : 'a0',
                content: '',
                tiptap_content: null,
                is_checked: null,
                created_at:
                    typeof fields.created_at === 'string' ? fields.created_at : undefined,
                children: [],
            };
            byId.set(id, block);
            attach(block);
            treeChanged = true;
        } else if ('parent_id' in fields || 'position' in fields) {
            detach(block);

            if ('parent_id' in fields) {
                block.parent_id =
                    typeof fields.parent_id === 'string' ? fields.parent_id : pageId;
            }

            if (typeof fields.position === 'string') {
                block.position = fields.position;
            }

            attach(block);
            treeChanged = true;
        }

        if ('tiptap_content' in fields) {
            block.tiptap_content = (fields.tiptap_content ?? null) as TiptapContent;

            if (block.tiptap_content === null && typeof fields.content === 'string') {
                block.tiptap_content = paragraph(fields.content);
            }

            touched.add(id);
        } else if ('content' in fields) {
            block.tiptap_content = paragraph(String(fields.content ?? ''));
            touched.add(id);
        }

        if ('is_checked' in fields) {
            block.is_checked =
                typeof fields.is_checked === 'boolean' ? fields.is_checked : null;
            treeChanged = true;
        }
    }

    // Parents created later in the same batch adopt their children; anything
    // still orphaned keeps its content at the end of the page
    for (let progress = true; progress && orphans.length > 0; ) {
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

    if (treeChanged || touched.size > 0) {
        changed =
            applyBlocks(doc, roots, {
                contentChanged: (block) => touched.has(block.id),
            }) || changed;
    }

    return changed;
}
