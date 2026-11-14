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
});
