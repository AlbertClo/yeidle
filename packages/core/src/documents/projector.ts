import { placeholders } from '../db/database';
import type { Database } from '../db/database';
import type { DocumentRows, MediaRow, PageRow } from '../loro/projection';
import { parseTime } from '../loro/projection';

/**
 * Writes a document's projected rows into the read model: pages, blocks,
 * links, the search index and media. Only rows that differ are written, and
 * what left the document is deleted. Nothing else writes these tables.
 */

type StoredPage = {
    title: string;
    kind: string;
    daily_date: string | null;
    created_at: number;
};

type StoredBlock = {
    search_id: number;
    id: string;
    page_id: string;
    text: string;
};

export class Projector {
    constructor(private db: Database) {}

    /** Returns whether anything changed. */
    write(documentId: string, rows: DocumentRows): boolean {
        const now = Date.now();
        let changed = false;

        for (const media of rows.media) {
            changed = this.writeMedia(media, now) || changed;
        }

        if (rows.page === null) {
            return changed;
        }

        const page = rows.page;
        const stored = this.db.get<StoredPage>(
            'SELECT title, kind, daily_date, created_at FROM pages WHERE id = ?',
            [documentId],
        );

        // A page whose blocks arrived before its fields is listed untitled
        if (page.deleted || (!page.has_meta && rows.blocks.length === 0)) {
            if (stored !== undefined) {
                this.deletePage(documentId);
                changed = true;
            }

            return changed;
        }

        const createdAt = page.created_at ?? stored?.created_at ?? now;
        let pageChanged = false;

        if (stored === undefined) {
            this.db.run(
                `INSERT INTO pages (id, title, kind, daily_date, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    documentId,
                    page.title,
                    page.kind,
                    page.daily_date,
                    createdAt,
                    now,
                ],
            );
            pageChanged = true;
        } else if (differs(stored, page, createdAt)) {
            this.db.run(
                'UPDATE pages SET title = ?, kind = ?, daily_date = ?, created_at = ? WHERE id = ?',
                [page.title, page.kind, page.daily_date, createdAt, documentId],
            );
            pageChanged = true;
        }

        const blocksChanged = this.writeBlocks(documentId, rows);

        if (pageChanged || blocksChanged) {
            this.db.run('UPDATE pages SET updated_at = ? WHERE id = ?', [
                now,
                documentId,
            ]);
        }

        return changed || pageChanged || blocksChanged;
    }

    /** Empties the read model (before rebuilding it). */
    clear(): void {
        this.db.exec(`
            INSERT INTO block_search(block_search) VALUES ('delete-all');
            DELETE FROM links;
            DELETE FROM blocks;
            DELETE FROM pages;
            DELETE FROM media;
        `);
    }

    private writeBlocks(pageId: string, rows: DocumentRows): boolean {
        const existing = new Map<string, StoredBlock>();

        for (const block of this.db.all<StoredBlock>(
            'SELECT search_id, id, page_id, text FROM blocks WHERE page_id = ?',
            [pageId],
        )) {
            existing.set(block.id, block);
        }

        const links = new Map<string, string[]>();

        for (const link of this.db.all<{
            source_block_id: string;
            target_id: string;
        }>(
            `SELECT links.source_block_id, links.target_id FROM links
             INNER JOIN blocks ON blocks.id = links.source_block_id
             WHERE blocks.page_id = ?
             ORDER BY links.target_id`,
            [pageId],
        )) {
            const targets = links.get(link.source_block_id) ?? [];
            targets.push(link.target_id);
            links.set(link.source_block_id, targets);
        }

        // Blocks that another page's projection still holds (moved between
        // pages): the page that has them now takes them over
        const elsewhere = new Map<string, StoredBlock>();
        const unknown = rows.blocks
            .map((block) => block.id)
            .filter((id) => !existing.has(id));

        for (let i = 0; i < unknown.length; i += 500) {
            const chunk = unknown.slice(i, i + 500);

            for (const block of this.db.all<StoredBlock>(
                `SELECT search_id, id, page_id, text FROM blocks WHERE id IN (${placeholders(chunk.length)})`,
                chunk,
            )) {
                elsewhere.set(block.id, block);
            }
        }

        let changed = false;
        const live = new Set<string>();

        for (const block of rows.blocks) {
            live.add(block.id);
            const old = existing.get(block.id) ?? elsewhere.get(block.id);

            if (old === undefined) {
                const searchId = this.db.run(
                    'INSERT INTO blocks (id, page_id, text) VALUES (?, ?, ?)',
                    [block.id, pageId, block.text],
                ).lastInsertRowid;
                this.index(searchId, block.text);
                changed = true;
            } else if (old.page_id !== pageId || old.text !== block.text) {
                this.unindex(old.search_id, old.text);
                this.db.run(
                    'UPDATE blocks SET page_id = ?, text = ? WHERE search_id = ?',
                    [pageId, block.text, old.search_id],
                );
                this.index(old.search_id, block.text);
                changed = true;
            }

            // A block taken over from another page brings its links along
            const oldLinks = elsewhere.has(block.id)
                ? null
                : (links.get(block.id) ?? []);

            if (oldLinks === null || oldLinks.join() !== block.links.join()) {
                this.db.run('DELETE FROM links WHERE source_block_id = ?', [
                    block.id,
                ]);

                for (const target of block.links) {
                    this.db.run(
                        'INSERT INTO links (source_block_id, target_id) VALUES (?, ?)',
                        [block.id, target],
                    );
                }

                changed = true;
            }
        }

        for (const old of existing.values()) {
            if (!live.has(old.id)) {
                this.unindex(old.search_id, old.text);
                this.db.run('DELETE FROM blocks WHERE search_id = ?', [
                    old.search_id,
                ]);
                changed = true;
            }
        }

        return changed;
    }

    private deletePage(pageId: string): void {
        for (const block of this.db.all<StoredBlock>(
            'SELECT search_id, id, page_id, text FROM blocks WHERE page_id = ?',
            [pageId],
        )) {
            this.unindex(block.search_id, block.text);
        }

        // Blocks and their links go with it
        this.db.run('DELETE FROM pages WHERE id = ?', [pageId]);
    }

    private index(searchId: number, text: string): void {
        this.db.run('INSERT INTO block_search (rowid, text) VALUES (?, ?)', [
            searchId,
            text,
        ]);
    }

    private unindex(searchId: number, text: string): void {
        this.db.run(
            "INSERT INTO block_search (block_search, rowid, text) VALUES ('delete', ?, ?)",
            [searchId, text],
        );
    }

    private writeMedia(media: MediaRow, now: number): boolean {
        return (
            this.db.run(
                `INSERT OR IGNORE INTO media (id, hash, original_name, mime_type, size, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                    media.id,
                    media.hash,
                    media.original_name,
                    media.mime_type,
                    media.size,
                    parseTime(media.created_at) ?? now,
                ],
            ).changes > 0
        );
    }
}

function differs(
    stored: StoredPage,
    page: PageRow,
    createdAt: number,
): boolean {
    return (
        stored.title !== page.title ||
        stored.kind !== page.kind ||
        stored.daily_date !== page.daily_date ||
        stored.created_at !== createdAt
    );
}
