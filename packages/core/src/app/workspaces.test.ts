import { afterEach, beforeEach, expect, it } from 'vitest';

import { Meta } from '../db/meta';
import { READ_MODEL_VERSION } from '../db/schema';
import { createPage } from '../documents/testing';

import { testContext } from './testing';

let ctx: ReturnType<typeof testContext>;

beforeEach(() => {
    ctx = testContext();
});

afterEach(() => ctx.cleanup());

it('rebuilds a read model built by another version when the workspace opens', () => {
    const pageId = createPage(ctx.documents(), 'Lighting', {
        blocks: [{ text: 'Lamp shop' }],
    });
    expect(new Meta(ctx.db()).number('read_model_version')).toBe(
        READ_MODEL_VERSION,
    );

    // As an older projector would have left it
    ctx.db().run("UPDATE blocks SET text = 'stale'");
    new Meta(ctx.db()).set('read_model_version', READ_MODEL_VERSION - 1);
    ctx.workspaces.close();

    const db = ctx.workspaces.active().db;

    expect(
        db.get('SELECT text FROM blocks WHERE page_id = ?', [pageId]),
    ).toEqual({ text: 'Lamp shop' });
    expect(new Meta(db).number('read_model_version')).toBe(READ_MODEL_VERSION);
});
