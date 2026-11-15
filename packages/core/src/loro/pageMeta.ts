import type { LoroDoc, LoroMap } from 'loro-crdt';

/**
 * Page-level fields of a page document, stored in its `page` map. Every
 * top-level node (a page or one of the hidden system roots) owns one document,
 * whose id is the node id.
 */

export const PAGE = 'page';

export type PageMeta = {
    title: string;
    page_type: 'daily_note' | null;
    daily_note_date: string | null;
    created_at: string | null;
    deleted: boolean;
};

const FIELDS = [
    'title',
    'page_type',
    'daily_note_date',
    'created_at',
    'deleted',
] as const;

function pageMap(doc: LoroDoc): LoroMap {
    return doc.getMap(PAGE);
}

export function readPageMeta(doc: LoroDoc): PageMeta {
    const map = pageMap(doc);
    const title = map.get('title');
    const pageType = map.get('page_type');
    const date = map.get('daily_note_date');
    const created = map.get('created_at');

    return {
        title: typeof title === 'string' ? title : '',
        page_type: pageType === 'daily_note' ? 'daily_note' : null,
        daily_note_date: typeof date === 'string' ? date : null,
        created_at: typeof created === 'string' ? created : null,
        deleted: map.get('deleted') === true,
    };
}

/** Whether the document has ever had page fields written. */
export function hasPageMeta(doc: LoroDoc): boolean {
    return pageMap(doc).size > 0;
}

/** Writes the given fields, skipping unchanged ones. Returns whether anything changed. */
export function updatePageMeta(
    doc: LoroDoc,
    fields: Partial<PageMeta>,
): boolean {
    const map = pageMap(doc);
    let changed = false;

    for (const field of FIELDS) {
        if (!(field in fields)) {
            continue;
        }

        const value = fields[field] ?? null;
        const current = map.get(field) ?? null;

        if (current === value) {
            continue;
        }

        if (value === null || value === false) {
            if (current !== null) {
                map.delete(field);
                changed = true;
            }

            continue;
        }

        map.set(field, value);
        changed = true;
    }

    return changed;
}
