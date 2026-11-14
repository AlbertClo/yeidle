import { invalid } from '../../http/http';
import { placeholders } from '../../db/database';
import { parseTimestamp, sqlTimestamp } from '../../support/time';
import { cloudProfileKey } from '../cloud/profile';
import type { AppContext } from '../context';

/**
 * The back/forward tree of visited locations, per profile. Local UI state:
 * written straight to the workspace database, outside the documents.
 */

export const MAX_NAVIGATION_LOCATIONS = 500;

export type NavigationLocationInput = {
    parent_id?: string | null;
    url: string;
    page_id?: string | null;
    block_id?: string | null;
    cursor_offset?: number | null;
    selection_type?: string | null;
    scroll_top: number;
    visited_at: string;
    last_visited_at: string;
};

export type NavigationLocation = {
    id: string;
    parent_id: string | null;
    url: string;
    page_id: string | null;
    block_id: string | null;
    cursor_offset: number | null;
    selection_type: string | null;
    scroll_top: number;
    visited_at: string;
    last_visited_at: string;
    page_title: string | null;
    node_text: string | null;
};

type LocationRow = {
    id: string;
    parent_id: string | null;
    url: string;
    page_id: string | null;
    block_id: string | null;
    cursor_offset: number | null;
    selection_type: string | null;
    scroll_top: number;
    visited_at: string;
    last_visited_at: string;
    page_title?: string | null;
    node_text?: string | null;
};

/** History belongs to the signed-in cloud user (`cloud:<id>`), else `local`. */
export function navigationProfileKey(ctx: AppContext): string {
    return cloudProfileKey(ctx);
}

export class NavigationHistoryStore {
    constructor(
        private ctx: AppContext,
        private profileKey: () => string = () => navigationProfileKey(ctx),
    ) {}

    get(): { locations: NavigationLocation[]; current_id: string | null } {
        const db = this.ctx.db();
        const profileKey = this.profileKey();
        const locations = db
            .all<LocationRow>(
                `SELECT navigation_locations.*, page_nodes.content AS page_title, block_nodes.content AS node_text
                 FROM navigation_locations
                 LEFT JOIN nodes AS page_nodes ON navigation_locations.page_id = page_nodes.id
                 LEFT JOIN nodes AS block_nodes ON navigation_locations.block_id = block_nodes.id
                 WHERE navigation_locations.profile_key = ?
                 ORDER BY navigation_locations.visited_at`,
                [profileKey],
            )
            .map(serialize);
        const currentId = this.currentId(profileKey);

        return {
            locations,
            current_id: locations.some((location) => location.id === currentId)
                ? currentId
                : null,
        };
    }

    save(
        id: string,
        location: NavigationLocationInput,
        makeCurrent: boolean,
    ): NavigationLocation {
        const db = this.ctx.db();
        const profileKey = this.profileKey();
        const parentId = location.parent_id ?? null;

        if (
            parentId !== null &&
            db.get(
                'SELECT 1 FROM navigation_locations WHERE id = ? AND profile_key = ?',
                [parentId, profileKey],
            ) === undefined
        ) {
            invalid(
                'parent_id',
                'The parent navigation location does not exist.',
            );
        }

        const now = sqlTimestamp();
        const row: LocationRow = {
            id,
            parent_id: parentId,
            url: location.url,
            page_id: location.page_id ?? null,
            block_id: location.block_id ?? null,
            cursor_offset: location.cursor_offset ?? null,
            selection_type: location.selection_type ?? null,
            scroll_top: location.scroll_top,
            visited_at: storedTimestamp(location.visited_at),
            last_visited_at: storedTimestamp(location.last_visited_at),
        };

        db.transaction(() => {
            db.run(
                `INSERT INTO navigation_locations
                    (id, profile_key, parent_id, url, page_id, block_id, cursor_offset, selection_type,
                     scroll_top, visited_at, last_visited_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET
                    parent_id = excluded.parent_id,
                    url = excluded.url,
                    page_id = excluded.page_id,
                    block_id = excluded.block_id,
                    cursor_offset = excluded.cursor_offset,
                    selection_type = excluded.selection_type,
                    scroll_top = excluded.scroll_top,
                    last_visited_at = excluded.last_visited_at,
                    updated_at = excluded.updated_at`,
                [
                    row.id,
                    profileKey,
                    row.parent_id,
                    row.url,
                    row.page_id,
                    row.block_id,
                    row.cursor_offset,
                    row.selection_type,
                    row.scroll_top,
                    row.visited_at,
                    row.last_visited_at,
                    now,
                    now,
                ],
            );

            if (makeCurrent) {
                this.writeCurrent(profileKey, id, now);
            }
        });

        this.prune(profileKey);

        return serialize(row);
    }

    setCurrent(id: string): void {
        const db = this.ctx.db();
        const profileKey = this.profileKey();

        if (
            db.get(
                'SELECT 1 FROM navigation_locations WHERE id = ? AND profile_key = ?',
                [id, profileKey],
            ) === undefined
        ) {
            invalid('id', 'The navigation location does not exist.');
        }

        const now = sqlTimestamp();

        db.transaction(() => {
            db.run(
                'UPDATE navigation_locations SET last_visited_at = ?, updated_at = ? WHERE id = ? AND profile_key = ?',
                [now, now, id, profileKey],
            );
            this.writeCurrent(profileKey, id, now);
        });
    }

    clear(): void {
        const db = this.ctx.db();
        const profileKey = this.profileKey();

        db.transaction(() => {
            db.run(
                'DELETE FROM navigation_history_states WHERE profile_key = ?',
                [profileKey],
            );
            db.run('DELETE FROM navigation_locations WHERE profile_key = ?', [
                profileKey,
            ]);
        });
    }

    private currentId(profileKey: string): string | null {
        const state = this.ctx
            .db()
            .get<{
                current_location_id: string | null;
            }>('SELECT current_location_id FROM navigation_history_states WHERE profile_key = ?', [profileKey]);

        return typeof state?.current_location_id === 'string'
            ? state.current_location_id
            : null;
    }

    /** Matches Laravel's updateOrInsert: created_at is rewritten on update too. */
    private writeCurrent(profileKey: string, id: string, now: string): void {
        this.ctx.db().run(
            `INSERT INTO navigation_history_states (profile_key, current_location_id, created_at, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (profile_key) DO UPDATE SET
                current_location_id = excluded.current_location_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at`,
            [profileKey, id, now, now],
        );
    }

    /** Drops least-recently visited leaves, never the current location or its ancestors. */
    private prune(profileKey: string): void {
        const db = this.ctx.db();
        const locations = db.all<{
            id: string;
            parent_id: string | null;
            last_visited_at: string;
        }>(
            'SELECT id, parent_id, last_visited_at FROM navigation_locations WHERE profile_key = ?',
            [profileKey],
        );

        if (locations.length <= MAX_NAVIGATION_LOCATIONS) {
            return;
        }

        const remaining = new Map(
            locations.map((location) => [location.id, location]),
        );
        const protectedIds = new Set<string>();

        for (
            let id = this.currentId(profileKey);
            id !== null && remaining.has(id) && !protectedIds.has(id);
            id = remaining.get(id)!.parent_id
        ) {
            protectedIds.add(id);
        }

        const remove: string[] = [];

        while (remaining.size > MAX_NAVIGATION_LOCATIONS) {
            const parentIds = new Set<string>();

            for (const location of remaining.values()) {
                if (location.parent_id) {
                    parentIds.add(location.parent_id);
                }
            }

            let leaf: (typeof locations)[number] | null = null;

            for (const location of remaining.values()) {
                if (
                    protectedIds.has(location.id) ||
                    parentIds.has(location.id)
                ) {
                    continue;
                }

                if (
                    leaf === null ||
                    location.last_visited_at < leaf.last_visited_at
                ) {
                    leaf = location;
                }
            }

            if (leaf === null) {
                break;
            }

            remove.push(leaf.id);
            remaining.delete(leaf.id);
        }

        for (let i = 0; i < remove.length; i += 500) {
            const batch = remove.slice(i, i + 500);
            db.run(
                `DELETE FROM navigation_locations WHERE profile_key = ? AND id IN (${placeholders(batch.length)})`,
                [profileKey, ...batch],
            );
        }
    }
}

function storedTimestamp(value: string): string {
    const date = parseTimestamp(value);

    if (date === null) {
        throw new Error(`Invalid timestamp [${value}].`);
    }

    return sqlTimestamp(date);
}

/** Carbon's toIso8601String in UTC: `2026-08-30T01:00:00+00:00`. */
function iso8601(value: string): string {
    const date = parseTimestamp(value);

    return date === null ? value : `${date.toISOString().slice(0, 19)}+00:00`;
}

function serialize(location: LocationRow): NavigationLocation {
    return {
        id: location.id,
        parent_id: location.parent_id,
        url: location.url,
        page_id: location.page_id,
        block_id: location.block_id,
        cursor_offset:
            location.cursor_offset === null
                ? null
                : Number(location.cursor_offset),
        selection_type: location.selection_type ?? null,
        scroll_top: Number(location.scroll_top),
        visited_at: iso8601(location.visited_at),
        last_visited_at: iso8601(location.last_visited_at),
        page_title: location.page_title ?? null,
        node_text: location.node_text ?? null,
    };
}
