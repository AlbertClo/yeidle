import type { Database } from '../db/database';
import { isUuid } from '../support/ids';

import type { Host } from './host';
import type { WorkspaceRecord } from './workspaces';

/**
 * Brings the NativePHP app's workspaces into a fresh data directory. The old
 * files are only read: each database is copied with VACUUM INTO (a consistent
 * copy even with a WAL) and media blobs are copied, so the NativePHP app keeps
 * working. The copies are converted to Loro documents when first opened.
 *
 * NativePHP layout (under its app data directory):
 *   database/workspaces.json
 *   database/database.sqlite                 — the first ("Personal") workspace
 *   database/workspaces/<id>.sqlite          — other workspaces
 *   storage/app/private/media/<sha256>       — media of the first workspace
 *   database/workspaces/<id>/storage/media/  — media of other workspaces
 */

type LegacyWorkspace = { id: string; name: string; database: string };

export type LegacyImportResult = { imported: string[]; activeWorkspaceId: string | null };

export function legacyIndexPath(host: Host, legacyDirectory: string): string {
    return host.files.join(legacyDirectory, 'database', 'workspaces.json');
}

export function importLegacyWorkspaces(
    host: Host,
    legacyDirectory: string,
    openDatabase: (path: string) => Database,
): LegacyImportResult {
    const files = host.files;
    const indexPath = legacyIndexPath(host, legacyDirectory);

    if (!files.isFile(indexPath)) {
        return { imported: [], activeWorkspaceId: null };
    }

    const state = JSON.parse(files.readText(indexPath)) as {
        active_workspace_id?: string;
        workspaces?: LegacyWorkspace[];
    };
    const legacyDatabaseDirectory = files.join(legacyDirectory, 'database');
    const records: WorkspaceRecord[] = [];

    for (const workspace of state.workspaces ?? []) {
        if (!isUuid(workspace.id) || typeof workspace.database !== 'string') {
            continue;
        }

        const source = files.join(legacyDatabaseDirectory, workspace.database);

        if (!files.isFile(source) || workspace.database.split(/[\\/]/).includes('..')) {
            continue;
        }

        const target = files.join(host.dataDirectory, 'workspaces', `${workspace.id}.sqlite`);
        files.mkdir(files.dirname(target));
        files.unlink(target);

        // Work from a scratch copy (with its WAL) so SQLite never touches
        // the original files, not even their shared-memory index
        const scratch = `${target}.import`;

        for (const suffix of ['', '-wal']) {
            files.unlink(scratch + suffix);

            if (files.isFile(source + suffix)) {
                files.copy(source + suffix, scratch + suffix);
            }
        }

        const db = openDatabase(scratch);

        try {
            db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
        } finally {
            db.close();

            for (const suffix of ['', '-wal', '-shm']) {
                files.unlink(scratch + suffix);
            }
        }

        const media =
            workspace.database === 'database.sqlite'
                ? files.join(legacyDirectory, 'storage', 'app', 'private', 'media')
                : files.join(legacyDatabaseDirectory, 'workspaces', workspace.id, 'storage', 'media');
        const targetMedia = files.join(host.dataDirectory, 'workspaces', workspace.id, 'storage', 'media');

        if (files.isDirectory(media)) {
            files.mkdir(files.dirname(targetMedia));
            files.copy(media, targetMedia);
        }

        records.push({
            id: workspace.id,
            name: typeof workspace.name === 'string' && workspace.name.trim() !== '' ? workspace.name : 'Workspace',
            database: `workspaces/${workspace.id}.sqlite`,
            cloud_account_id: null,
            cloud_status: 'local',
            cloud_role: null,
            cloud_owned: null,
            cloud_error: null,
        });
    }

    if (records.length === 0) {
        return { imported: [], activeWorkspaceId: null };
    }

    const active = records.some((record) => record.id === state.active_workspace_id)
        ? state.active_workspace_id!
        : records[0].id;
    files.mkdir(host.dataDirectory);
    files.writeFile(
        files.join(host.dataDirectory, 'workspaces.json'),
        `${JSON.stringify({ version: 3, active_workspace_id: active, workspaces: records }, null, 4)}\n`,
    );

    return { imported: records.map((record) => record.id), activeWorkspaceId: active };
}
