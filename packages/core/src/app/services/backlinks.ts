import type { Database } from '../../db/database';

export type Backlink = { id: string; page_id: string; page_title: string };

/** Pages linking to a node: one entry per source page, with its title. */
export function loadBacklinks(db: Database, targetNodeId: string): Backlink[] {
    const rows = db.all<{ id: string; page_id: string; page_title: string | null }>(
        `WITH RECURSIVE ancestors AS (
            SELECT node_links.id AS link_id, nodes.id AS node_id,
                nodes.parent_id, nodes.content
            FROM node_links
            INNER JOIN nodes ON nodes.id = node_links.source_node_id
            WHERE node_links.target_node_id = ?
                AND node_links.deleted_at IS NULL
                AND nodes.deleted_at IS NULL

            UNION

            SELECT ancestors.link_id, parents.id, parents.parent_id,
                parents.content
            FROM ancestors
            INNER JOIN nodes AS parents ON parents.id = ancestors.parent_id
            WHERE parents.deleted_at IS NULL
        )
        SELECT link_id AS id, node_id AS page_id, content AS page_title
        FROM ancestors
        WHERE parent_id IS NULL
        ORDER BY link_id`,
        [targetNodeId],
    );

    const backlinks: Backlink[] = [];
    const seenPages = new Set<string>();

    for (const row of rows) {
        if (seenPages.has(row.page_id)) {
            continue;
        }

        seenPages.add(row.page_id);
        backlinks.push({
            id: row.id,
            page_id: row.page_id,
            // PHP's `?:` also treats "0" as empty
            page_title: row.page_title && row.page_title !== '0' ? row.page_title : '[untitled]',
        });
    }

    return backlinks;
}
