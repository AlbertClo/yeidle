import type { LoroDoc } from 'loro-crdt';

import { extractMentions } from '../documents/linkParser';
import { isUuid } from '../support/ids';

import { flattenBlocks, readBlocks } from './pageDoc';
import { hasPageMeta, readPageMeta } from './pageMeta';

/**
 * The rows a document contributes to the read model (pages, blocks, links,
 * media). The projector writes them; nothing else writes those tables.
 */

export type PageRow = {
    id: string;
    title: string;
    kind: 'page' | 'daily';
    daily_date: string | null;
    /** Unix ms, when the document records one. */
    created_at: number | null;
    deleted: boolean;
    /** False when only blocks have arrived so far (no page fields yet). */
    has_meta: boolean;
};

export type BlockRow = {
    id: string;
    text: string;
    /** Linked page and block ids (UUID mentions, references, embeds). */
    links: string[];
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

const NO_ROWS: DocumentRows = { page: null, blocks: [], media: [] };

/** ISO 8601 (or any Date-parsable string) as unix ms. */
export function parseTime(value: string | null | undefined): number | null {
    if (!value) {
        return null;
    }

    const time = Date.parse(value);

    return Number.isNaN(time) ? null : time;
}

export function projectPage(doc: LoroDoc, pageId: string): DocumentRows {
    const meta = readPageMeta(doc);
    const daily = meta.page_type === 'daily_note' && meta.daily_note_date;

    return {
        page: {
            id: pageId,
            title: meta.title,
            kind: daily ? 'daily' : 'page',
            daily_date: daily ? meta.daily_note_date : null,
            created_at: daily
                ? Date.parse(`${meta.daily_note_date}T00:00:00Z`)
                : parseTime(meta.created_at),
            deleted: meta.deleted,
            has_meta: hasPageMeta(doc),
        },
        blocks: flattenBlocks(readBlocks(doc, pageId)).map((block) => ({
            id: block.id,
            text: block.content,
            links: [
                ...new Set(
                    extractMentions(block.tiptap_content)
                        .map((mention) => mention.id)
                        .filter((id) => isUuid(id) && id !== block.id),
                ),
            ].sort(),
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

/** Page documents are named by the page's UUID; other documents have no rows. */
export function projectDocument(
    doc: LoroDoc,
    documentId: string,
): DocumentRows {
    if (documentId === MEDIA_DOCUMENT_ID) {
        return projectMedia(doc);
    }

    return isUuid(documentId) ? projectPage(doc, documentId) : NO_ROWS;
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
