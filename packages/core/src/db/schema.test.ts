import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nodeFiles } from '../support/nodeFiles';

import { openNodeDatabase } from './nodeSqlite';
import { openWorkspaceDatabase, SCHEMA_VERSION } from './schema';

let directory: string;
let file: string;

beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeidle-schema-'));
    file = path.join(directory, 'workspace.sqlite');
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

const open = () => openWorkspaceDatabase(openNodeDatabase, nodeFiles, file);
const version = (db: ReturnType<typeof openNodeDatabase>) =>
    db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;

describe('openWorkspaceDatabase', () => {
    it('creates the schema in a new database', () => {
        const { db, setAside } = open();

        expect(setAside).toBeNull();
        expect(version(db)).toBe(SCHEMA_VERSION);
        expect(
            db.get("SELECT 1 FROM sqlite_master WHERE name = 'pages'"),
        ).toBeDefined();
        db.close();
    });

    it('opens a current database as it is', () => {
        const first = open();
        first.db.run("INSERT INTO meta (key, value) VALUES ('device_id', 'x')");
        first.db.close();

        const { db, setAside } = open();

        expect(setAside).toBeNull();
        expect(db.get('SELECT value FROM meta')).toEqual({ value: 'x' });
        db.close();
    });

    it('sets a database from another schema version aside', () => {
        const old = openNodeDatabase(file);
        old.exec('CREATE TABLE nodes (id TEXT); PRAGMA user_version = 3');
        old.exec("INSERT INTO nodes VALUES ('kept')");
        old.close();
        fs.writeFileSync(`${file}.old`, 'an earlier one');

        const { db, setAside } = open();

        expect(setAside).toBe(`${file}.2.old`);
        expect(version(db)).toBe(SCHEMA_VERSION);
        expect(
            db.get("SELECT 1 FROM sqlite_master WHERE name = 'nodes'"),
        ).toBeUndefined();
        db.close();

        const moved = openNodeDatabase(setAside!, { readOnly: true });
        expect(moved.get('SELECT id FROM nodes')).toEqual({ id: 'kept' });
        moved.close();
        expect(fs.readFileSync(`${file}.old`, 'utf8')).toBe('an earlier one');
    });
});
