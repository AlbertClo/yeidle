import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deletePage } from '../../documents/testing';
import { uuidv7 } from '../../support/ids';
import { findPage } from '../pages';
import { testContext } from '../testing';

import {
    dailyNotePageId,
    dailyNoteTitle,
    DailyNoteService,
} from './dailyNotes';

let ctx: ReturnType<typeof testContext>;

beforeEach(() => {
    ctx = testContext();
});

afterEach(() => ctx.cleanup());

describe('DailyNoteService', () => {
    it('creates one deterministic daily page per workspace and date', () => {
        const workspaceId = uuidv7();
        const service = new DailyNoteService(ctx);

        const first = service.open(workspaceId, '2026-08-30');
        const second = service.open(workspaceId, '2026-08-30');

        expect(first.id).toBe(dailyNotePageId(workspaceId, '2026-08-30'));
        expect(second.id).toBe(first.id);
        expect(first).toMatchObject({
            title: 'August 30, 2026',
            kind: 'daily',
            daily_date: '2026-08-30',
            created_at: Date.parse('2026-08-30T00:00:00Z'),
        });
        expect(
            ctx.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM pages')!.n,
        ).toBe(1);
        expect(
            ctx
                .db()
                .get<{ n: number }>(
                    'SELECT COUNT(*) AS n FROM document_updates',
                )!.n,
        ).toBe(1);
    });

    it('scopes daily page ids by workspace', () => {
        expect(dailyNotePageId(uuidv7(), '2026-08-30')).not.toBe(
            dailyNotePageId(uuidv7(), '2026-08-30'),
        );
    });

    it('restores a deleted daily note when opened', () => {
        const workspaceId = uuidv7();
        const service = new DailyNoteService(ctx);
        const page = service.open(workspaceId, '2026-08-30');
        deletePage(ctx.documents(), page.id);
        expect(findPage(ctx.db(), page.id)).toBeNull();

        const restored = service.open(workspaceId, '2026-08-30');

        expect(restored.id).toBe(page.id);
        expect(restored.kind).toBe('daily');
        expect(findPage(ctx.db(), page.id)).toEqual(restored);
    });

    it('formats titles like PHP F j, Y', () => {
        expect(dailyNoteTitle('2026-01-05')).toBe('January 5, 2026');
        expect(dailyNoteTitle('2026-12-31')).toBe('December 31, 2026');
    });
});
