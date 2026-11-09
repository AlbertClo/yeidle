import type { LoroDoc } from 'loro-crdt';

import { flattenBlocks, readBlocks } from './pageDoc';
import { hasPageMeta, readPageMeta } from './pageMeta';
import type { TiptapContent } from './richText';

/**
 * The rows a document contributes to the SQLite read model (the nodes,
 * node_links and media tables). PHP writes them; nothing else writes those
 * tables.
 */

export type PageRow = {
    id: string;
    content: string;
    page_type: 'daily_note' | null;
    daily_note_date: string | null;
    created_at: string | null;
    deleted: boolean;
    /** False when only blocks have arrived so far (no page fields yet). */
    has_meta: boolean;
};

export type BlockRow = {
    id: string;
    parent_id: string;
    position: string;
    content: string;
    tiptap_content: TiptapContent;
    is_checked: boolean | null;
    created_at: string | null;
};

export type MediaRow = {
    id: string;
    hash: string;
    original_name: string;
    mime_type: string;
    size: number;
    created_at: string | null;
};

export type DocumentRows = {
    page: PageRow | null;
    blocks: BlockRow[];
    media: MediaRow[];
};

export const MEDIA_DOCUMENT_ID = 'media';
export const MEDIA = 'media';

export function projectPage(doc: LoroDoc, pageId: string): DocumentRows {
    const meta = readPageMeta(doc);

    return {
        page: {
            id: pageId,
            content: meta.title,
            page_type: meta.page_type,
            daily_note_date: meta.daily_note_date,
            created_at: meta.created_at,
            deleted: meta.deleted,
            has_meta: hasPageMeta(doc),
        },
        blocks: flattenBlocks(readBlocks(doc, pageId)).map((block) => ({
            id: block.id,
            parent_id: block.parent_id!,
            position: block.position,
            content: block.content,
            tiptap_content: block.tiptap_content,
            is_checked: block.is_checked,
            created_at: block.created_at ?? null,
        })),
        media: [],
    };
}

export function projectMedia(doc: LoroDoc): DocumentRows {
    const media: MediaRow[] = [];

    for (const [id, value] of Object.entries(
        doc.getMap(MEDIA).toJSON() as Record<string, Partial<MediaRow>>,
    )) {
        if (
            typeof value?.hash !== 'string' ||
            !/^[0-9a-f]{64}$/.test(value.hash) ||
            typeof value.original_name !== 'string' ||
            typeof value.mime_type !== 'string' ||
            typeof value.size !== 'number' ||
            value.size < 1
        ) {
            continue;
        }

        media.push({
            id,
            hash: value.hash,
            original_name: value.original_name,
            mime_type: value.mime_type,
            size: value.size,
            created_at: value.created_at ?? null,
        });
    }

    return { page: null, blocks: [], media };
}

export function projectDocument(doc: LoroDoc, documentId: string): DocumentRows {
    return documentId === MEDIA_DOCUMENT_ID
        ? projectMedia(doc)
        : projectPage(doc, documentId);
}

/** Media metadata is immutable: create-if-absent. */
export function addMedia(doc: LoroDoc, row: MediaRow): boolean {
    const map = doc.getMap(MEDIA);

    if (map.get(row.id) !== undefined) {
        return false;
    }

    const { id, ...value } = row;
    map.set(id, value);

    return true;
}
