import { applyBlocks, readBlocks } from '../loro/pageDoc';
import type { Block } from '../loro/pageDoc';
import { updatePageMeta } from '../loro/pageMeta';
import type { PageMeta } from '../loro/pageMeta';
import type { TiptapContent } from '../loro/richText';
import { uuidv7 } from '../support/ids';

import type { DocumentService } from './service';

/** Test helpers: pages and blocks written the way the app writes them. */

export type TestBlock = {
    id?: string;
    text?: string;
    /** Rich text; defaults to a paragraph of `text`. */
    content?: TiptapContent;
    checked?: boolean | null;
    children?: TestBlock[];
};

export function paragraph(text: string): TiptapContent {
    return text === ''
        ? { type: 'paragraph' }
        : { type: 'paragraph', content: [{ type: 'text', text }] };
}

/** A page mention, as the editor stores `[[label]]`. */
export function mention(id: string, label: string): Record<string, unknown> {
    return { type: 'mention', attrs: { id, label } };
}

/** A paragraph mixing text and inline nodes. */
export function inline(
    ...parts: (string | Record<string, unknown>)[]
): TiptapContent {
    return {
        type: 'paragraph',
        content: parts.map((part) =>
            typeof part === 'string' ? { type: 'text', text: part } : part,
        ),
    } as TiptapContent;
}

export function createPage(
    documents: DocumentService,
    title: string,
    options: {
        id?: string;
        blocks?: TestBlock[];
        meta?: Partial<PageMeta>;
    } = {},
): string {
    const id = options.id ?? uuidv7();
    documents.edit(id, (doc) =>
        updatePageMeta(doc, {
            title,
            created_at: new Date().toISOString(),
            deleted: false,
            ...options.meta,
        }),
    );

    if (options.blocks) {
        setBlocks(documents, id, options.blocks);
    }

    return id;
}

/** Replaces the page's blocks. Fills in missing ids and returns them in pre-order. */
export function setBlocks(
    documents: DocumentService,
    pageId: string,
    blocks: TestBlock[],
): string[] {
    const ids: string[] = [];

    const toBlocks = (list: TestBlock[], parentId: string): Block[] =>
        list.map((block) => {
            const id = (block.id ??= uuidv7());
            ids.push(id);

            return {
                id,
                parent_id: parentId,
                position: '',
                content: block.text ?? '',
                tiptap_content: block.content ?? paragraph(block.text ?? ''),
                is_checked: block.checked ?? null,
                children: toBlocks(block.children ?? [], id),
            };
        });

    const tree = toBlocks(blocks, pageId);
    documents.edit(pageId, (doc) => applyBlocks(doc, tree));

    return ids;
}

/** The page's blocks as text, nested: `['a', ['a1']]`-style outline strings. */
export function outline(documents: DocumentService, pageId: string): string[] {
    const lines: string[] = [];

    const visit = (list: Block[], depth: number) => {
        for (const block of list) {
            lines.push(`${'  '.repeat(depth)}${block.content}`);
            visit(block.children ?? [], depth + 1);
        }
    };

    visit(readBlocks(documents.read(pageId), pageId), 0);

    return lines;
}

export function deletePage(documents: DocumentService, pageId: string): void {
    documents.edit(pageId, (doc) => updatePageMeta(doc, { deleted: true }));
}
