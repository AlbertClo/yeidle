import { updatePageMeta } from '../../loro/pageMeta';
import { uuid5 } from '../../support/ids';
import type { AppContext } from '../context';
import { findPage } from '../pages';
import type { Page } from '../pages';

export const DAILY_NOTE_PAGE_TYPE = 'daily_note';

const UUID_NAMESPACE = '59563d4f-16f8-5ad7-a4ea-315cf0cae52d';

const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

/** Deterministic per workspace and date, so every replica opens the same page. */
export function dailyNotePageId(workspaceId: string, date: string): string {
    return uuid5(UUID_NAMESPACE, `workspace:${workspaceId}:daily-note:${date}`);
}

/** `2026-08-30` → `August 30, 2026` (PHP's `F j, Y`). */
export function dailyNoteTitle(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return `${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}, ${parsed.getUTCFullYear()}`;
}

/** Whether a string is a real calendar date in `Y-m-d` (Laravel's date_format:Y-m-d). */
export function isDailyNoteDate(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

export class DailyNoteService {
    constructor(private ctx: AppContext) {}

    /** Returns the day's page, creating (or restoring) it first. */
    open(workspaceId: string, date: string): Page {
        const db = this.ctx.db();
        const id = dailyNotePageId(workspaceId, date);
        const existing = findPage(db, id);

        if (existing !== null && existing.kind === 'daily') {
            return existing;
        }

        this.ctx.documents().edit(
            id,
            (doc) =>
                updatePageMeta(doc, {
                    title: dailyNoteTitle(date),
                    page_type: DAILY_NOTE_PAGE_TYPE,
                    daily_note_date: date,
                    created_at: `${date}T00:00:00.000Z`,
                    deleted: false,
                }),
            'Open daily note',
        );

        const page = findPage(db, id);

        if (page === null) {
            throw new Error(`Daily note ${id} was not created.`);
        }

        return page;
    }
}
