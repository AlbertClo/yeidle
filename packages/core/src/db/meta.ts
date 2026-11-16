import { uuidv7 } from '../support/ids';

import type { Database } from './database';

/**
 * This device's state for a workspace (the `meta` table): never synced.
 *
 *   device_id               this device, as the cloud relay knows it
 *   read_model_version      READ_MODEL_VERSION the read model was built with
 *   cloud_workspace_id      set once the workspace is paired with the cloud
 *   cloud_user_id           the cloud user it was paired as
 *   cloud_cursor            last cloud server_seq pulled
 *   cloud_last_attempt_at   unix ms
 *   cloud_last_success_at   unix ms
 *   cloud_last_error
 */
export type MetaKey =
    | 'device_id'
    | 'read_model_version'
    | 'cloud_workspace_id'
    | 'cloud_user_id'
    | 'cloud_cursor'
    | 'cloud_last_attempt_at'
    | 'cloud_last_success_at'
    | 'cloud_last_error';

export class Meta {
    constructor(private db: Database) {}

    get(key: MetaKey): string | null {
        return (
            this.db.get<{ value: string }>(
                'SELECT value FROM meta WHERE key = ?',
                [key],
            )?.value ?? null
        );
    }

    number(key: MetaKey): number | null {
        const value = this.get(key);

        return value === null ? null : Number(value);
    }

    /** Null removes the key. */
    set(key: MetaKey, value: string | number | null): void {
        if (value === null) {
            this.db.run('DELETE FROM meta WHERE key = ?', [key]);

            return;
        }

        this.db.run(
            'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
            [key, String(value)],
        );
    }

    deviceId(): string {
        let id = this.get('device_id');

        if (id === null) {
            id = uuidv7();
            this.set('device_id', id);
        }

        return id;
    }
}
