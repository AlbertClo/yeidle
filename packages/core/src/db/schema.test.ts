import { describe, expect, it } from 'vitest';

import { openNodeDatabase } from './nodeSqlite';
import { migrate, SCHEMA_VERSION } from './schema';

const version = (db: ReturnType<typeof openNodeDatabase>) =>
    db.get<{ user_version: number }>('PRAGMA user_version')!.user_version;

describe('migrate', () => {
    it('brings a new database to the current version', () => {
        const db = openNodeDatabase(':memory:');
        migrate(db);

        expect(version(db)).toBe(SCHEMA_VERSION);
        expect(
            db.get(
                "SELECT 1 FROM sqlite_master WHERE name = 'document_updates'",
            ),
        ).toBeDefined();

        // Running again is a no-op
        migrate(db);
        expect(version(db)).toBe(SCHEMA_VERSION);
    });

    it('drops cloud pairings from the operation-log era', () => {
        const db = openNodeDatabase(':memory:');
        migrate(db);
        db.exec('PRAGMA user_version = 1');
        db.run(
            `INSERT INTO sync_state (client_id, last_server_seq, cloud_url, cloud_token, workspace_id)
             VALUES ('device', 42, 'http://cloud', 'token', 'ws')`,
        );

        migrate(db);

        expect(db.get('SELECT * FROM sync_state')).toMatchObject({
            client_id: 'device',
            last_server_seq: 0,
            cloud_url: null,
            cloud_token: null,
            workspace_id: null,
        });
        expect(version(db)).toBe(SCHEMA_VERSION);
    });

    it('turns modification stamps from the old clock format into timestamps', () => {
        const db = openNodeDatabase(':memory:');
        migrate(db);
        db.exec('ALTER TABLE nodes RENAME COLUMN modified_at TO modified_hlc');
        db.exec('PRAGMA user_version = 2');
        // An HLC from the operation-log era, a stamp from before this step, an empty one
        db.exec(`INSERT INTO nodes (id, content, modified_hlc) VALUES
            ('a', 'A', '001763201523456-0003-client-1'),
            ('b', 'B', '001763201523457-0000-local'),
            ('c', 'C', '')`);

        migrate(db);

        expect(
            db.all(
                'SELECT id, modified_at FROM nodes ORDER BY modified_at DESC',
            ),
        ).toEqual([
            { id: 'b', modified_at: '2025-11-15T10:12:03.457Z' },
            { id: 'a', modified_at: '2025-11-15T10:12:03.456Z' },
            { id: 'c', modified_at: '' },
        ]);
        expect(
            db.get(
                "SELECT sql FROM sqlite_master WHERE name = 'nodes_page_order_index'",
            ),
        ).toEqual({ sql: expect.stringContaining('"modified_at"') });
    });
});
