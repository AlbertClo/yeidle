import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { openNodeDatabase } from '../db/nodeSqlite';
import { uuidv7 } from '../support/ids';

import { importLegacyWorkspaces } from './legacyImport';
import { testContext } from './testing';

let ctx: ReturnType<typeof testContext>;
let legacy: string;

beforeEach(() => {
    ctx = testContext();
    legacy = fs.mkdtempSync(path.join(ctx.host.dataDirectory, '..', 'yeidle-legacy-'));
});

afterEach(() => {
    ctx.cleanup();
    fs.rmSync(legacy, { recursive: true, force: true });
});

function legacyDatabase(file: string, pageTitle: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = openNodeDatabase(file);
    db.exec(`CREATE TABLE nodes (id varchar primary key, parent_id varchar, position varchar not null default 'a0',
        content text not null default '', is_checked tinyint(1), created_at datetime, updated_at datetime,
        deleted_at datetime, tiptap_content text, field_clocks text, purged tinyint(1) not null default 0,
        modified_hlc text not null default '', page_type varchar, daily_note_date date);
        CREATE TABLE media (id varchar primary key, filename varchar not null, original_name varchar not null,
        mime_type varchar not null, size integer not null, created_at datetime, updated_at datetime, cloud_uploaded_at datetime);`);
    const page = uuidv7();
    db.run("INSERT INTO nodes (id, content) VALUES (?, ?)", [page, pageTitle]);
    db.run("INSERT INTO nodes (id, parent_id, content) VALUES (?, ?, 'a block')", [uuidv7(), page]);
    db.close();
}

it('copies NativePHP workspaces and their media, leaving the originals untouched', () => {
    const personal = uuidv7();
    const research = uuidv7();
    legacyDatabase(path.join(legacy, 'database', 'database.sqlite'), 'Personal page');
    legacyDatabase(path.join(legacy, 'database', 'workspaces', `${research}.sqlite`), 'Research page');
    fs.mkdirSync(path.join(legacy, 'storage', 'app', 'private', 'media'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'storage', 'app', 'private', 'media', 'abc'), 'blob');
    fs.writeFileSync(
        path.join(legacy, 'database', 'workspaces.json'),
        JSON.stringify({
            version: 3,
            active_workspace_id: research,
            workspaces: [
                { id: personal, name: 'Personal', database: 'database.sqlite' },
                { id: research, name: 'Research', database: `workspaces/${research}.sqlite` },
            ],
        }),
    );
    const before = fs.readFileSync(path.join(legacy, 'database', 'database.sqlite'));

    const result = importLegacyWorkspaces(ctx.host, legacy, (file) =>
        openNodeDatabase(file),
    );

    expect(result.imported).toEqual([personal, research]);
    expect(ctx.workspaces.state().active_workspace_id).toBe(research);
    // Opening the active workspace converts it to documents
    expect(ctx.db().get('SELECT content FROM nodes WHERE parent_id IS NULL')).toEqual({ content: 'Research page' });
    expect(ctx.db().get('SELECT COUNT(*) AS n FROM documents')).toEqual({ n: 1 });

    ctx.workspaces.activate(personal);
    expect(ctx.db().get('SELECT content FROM nodes WHERE parent_id IS NOT NULL')).toEqual({ content: 'a block' });
    expect(fs.readFileSync(path.join(ctx.workspace().storagePath, 'media', 'abc'), 'utf8')).toBe('blob');
    expect(fs.readFileSync(path.join(legacy, 'database', 'database.sqlite')).equals(before)).toBe(true);
});
