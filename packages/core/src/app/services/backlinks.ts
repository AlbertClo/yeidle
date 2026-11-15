import type { Database } from '../../db/database';

/** `id` is the first linking block on the page. */
export type Backlink = { id: string; page_id: string; page_title: string };

/** Pages linking to a page or block: one entry per page, most recently changed first. */
export function loadBacklinks(db: Database, targetId: string): Backlink[] {
    return db
        .all<{ id: string; page_id: string; page_title: string }>(
            `SELECT MIN(blocks.id) AS id, pages.id AS page_id, pages.title AS page_title
             FROM links
             INNER JOIN blocks ON blocks.id = links.source_block_id
             INNER JOIN pages ON pages.id = blocks.page_id
             WHERE links.target_id = ?
             GROUP BY pages.id
             ORDER BY pages.updated_at DESC, pages.id`,
            [targetId],
        )
        .map((row) => ({
            ...row,
            page_title: row.page_title !== '' ? row.page_title : '[untitled]',
        }));
}
