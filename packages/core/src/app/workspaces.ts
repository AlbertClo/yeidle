import type { Database } from '../db/database';
import { migrate } from '../db/schema';
import {
    legacyMigrationNeeded,
    runLegacyMigration,
} from '../documents/legacyMigration';
import { DocumentService } from '../documents/service';
import { isUuid, uuidv7 } from '../support/ids';

import type { Host } from './host';

/**
 * The local workspace index (`workspaces.json`): one SQLite database and one
 * storage directory per workspace, all inside the app data directory.
 *
 *   <data>/workspaces.json
 *   <data>/workspaces/<id>.sqlite
 *   <data>/workspaces/<id>/storage/media/<sha256>
 */

export type CloudStatus = 'local' | 'available' | 'syncing' | 'ready' | 'error';

export type WorkspaceRecord = {
    id: string;
    name: string;
    database: string;
    cloud_account_id: string | null;
    cloud_status: CloudStatus;
    cloud_role: string | null;
    cloud_owned: boolean | null;
    cloud_error: string | null;
};

export type WorkspaceState = {
    active_workspace_id: string;
    workspaces: WorkspaceRecord[];
};

/** An open workspace. */
export type Workspace = {
    id: string;
    name: string;
    record: WorkspaceRecord;
    db: Database;
    documents: DocumentService;
    databasePath: string;
    storagePath: string;
    /** Set when the database file was missing and an empty one was created. */
    recoveredMissingDatabase: boolean;
};

const VERSION = 3;

export class WorkspaceError extends Error {}

export class Workspaces {
    private open: Workspace | null = null;
    private indexPath: string;

    constructor(
        private host: Host,
        private openDatabase: (path: string) => Database,
        /** Called whenever a workspace is opened (startup or switch). */
        private onOpen: (workspace: Workspace) => void = () => {},
    ) {
        this.indexPath = host.files.join(host.dataDirectory, 'workspaces.json');
    }

    state(): WorkspaceState {
        const state = this.read();

        return {
            active_workspace_id: state.active_workspace_id,
            workspaces: state.workspaces,
        };
    }

    all(): WorkspaceRecord[] {
        return this.read().workspaces;
    }

    find(id: string): WorkspaceRecord {
        const workspace = this.read().workspaces.find(
            (candidate) => candidate.id === id,
        );

        if (!workspace) {
            throw new WorkspaceError(`Local workspace [${id}] was not found.`);
        }

        return workspace;
    }

    /** The active workspace, opened (and migrated) on first use. */
    active(): Workspace {
        const state = this.read();

        if (this.open?.id === state.active_workspace_id) {
            return this.open;
        }

        this.close();
        this.open = this.openWorkspace(this.find(state.active_workspace_id));
        this.onOpen(this.open);

        return this.open;
    }

    create(name: string, id: string = uuidv7()): WorkspaceRecord {
        name = name.trim();

        if (name === '') {
            throw new WorkspaceError('Workspace name cannot be empty.');
        }

        if (!isUuid(id)) {
            throw new WorkspaceError('Workspace ID must be a UUID.');
        }

        const state = this.read();

        if (state.workspaces.some((workspace) => workspace.id === id)) {
            throw new WorkspaceError(`Workspace [${id}] already exists.`);
        }

        const record = this.createRecord(id, name);
        state.workspaces.push(record);
        this.write(state);

        return record;
    }

    rename(id: string, name: string): WorkspaceRecord {
        name = name.trim();

        if (name === '') {
            throw new WorkspaceError('Workspace name cannot be empty.');
        }

        const state = this.read();
        const record = state.workspaces.find(
            (workspace) => workspace.id === id,
        );

        if (!record) {
            throw new WorkspaceError(`Local workspace [${id}] was not found.`);
        }

        record.name = name;
        this.write(state);

        if (this.open?.id === id) {
            this.open.name = name;
            this.open.record = record;
        }

        return record;
    }

    activate(id: string): WorkspaceRecord {
        const state = this.read();
        const record = this.find(id);
        state.active_workspace_id = id;
        this.write(state);

        return record;
    }

    delete(id: string): WorkspaceState {
        const state = this.read();
        const record = this.find(id);
        state.workspaces = state.workspaces.filter(
            (workspace) => workspace.id !== id,
        );

        if (state.workspaces.length === 0) {
            state.workspaces.push(this.createRecord(uuidv7(), 'Personal'));
        }

        if (state.active_workspace_id === id) {
            state.active_workspace_id = state.workspaces[0].id;
        }

        this.write(state);

        if (this.open?.id === id) {
            this.close();
        }

        const files = this.host.files;
        const databasePath = this.databasePath(record);

        for (const suffix of ['', '-shm', '-wal']) {
            files.unlink(databasePath + suffix);
        }

        files.removeDirectory(files.dirname(this.storagePath(record)));

        return this.state();
    }

    databasePath(record: WorkspaceRecord): string {
        const database = record.database.replaceAll('\\', '/');

        if (
            database === '' ||
            database.startsWith('/') ||
            /^[A-Za-z]:\//.test(database) ||
            database.split('/').includes('..')
        ) {
            throw new WorkspaceError('The workspace database path is invalid.');
        }

        return this.host.files.join(this.host.dataDirectory, database);
    }

    storagePath(record: WorkspaceRecord): string {
        return this.host.files.join(
            this.host.dataDirectory,
            'workspaces',
            record.id,
            'storage',
        );
    }

    mediaPath(record: WorkspaceRecord): string {
        return this.host.files.join(this.storagePath(record), 'media');
    }

    /** Adds a workspace whose files were placed in the data directory already. */
    adopt(record: WorkspaceRecord): void {
        const state = this.read();

        if (state.workspaces.some((workspace) => workspace.id === record.id)) {
            throw new WorkspaceError(
                `Workspace [${record.id}] already exists.`,
            );
        }

        state.workspaces.push(record);
        this.write(state);
    }

    /**
     * Opens a workspace without making it active (an import into another
     * workspace). The caller closes its database when done.
     */
    openDetached(id: string): Workspace {
        if (this.open?.id === id) {
            return this.open;
        }

        return this.openWorkspace(this.find(id));
    }

    close(): void {
        this.open?.db.close();
        this.open = null;
    }

    private openWorkspace(record: WorkspaceRecord): Workspace {
        const files = this.host.files;
        const databasePath = this.databasePath(record);
        const recovered = !files.exists(databasePath);
        files.mkdir(files.dirname(databasePath));
        files.mkdir(this.storagePath(record));

        const db = this.openDatabase(databasePath);
        migrate(db);
        const documents = new DocumentService(db);

        // Workspaces written by the NativePHP app become Loro documents
        if (legacyMigrationNeeded(db)) {
            runLegacyMigration(db, documents);
        }

        return {
            id: record.id,
            name: record.name,
            record,
            db,
            documents,
            databasePath,
            storagePath: this.storagePath(record),
            recoveredMissingDatabase: recovered,
        };
    }

    private createRecord(id: string, name: string): WorkspaceRecord {
        const record: WorkspaceRecord = {
            id,
            name,
            database: `workspaces/${id}.sqlite`,
            cloud_account_id: null,
            cloud_status: 'local',
            cloud_role: null,
            cloud_owned: null,
            cloud_error: null,
        };
        const files = this.host.files;
        const path = this.databasePath(record);
        files.mkdir(files.dirname(path));
        const db = this.openDatabase(path);

        try {
            migrate(db);
        } finally {
            db.close();
        }

        return record;
    }

    private read(): WorkspaceState & { version: number } {
        const files = this.host.files;

        if (!files.exists(this.indexPath)) {
            const id = uuidv7();
            files.mkdir(this.host.dataDirectory);
            this.write({
                version: VERSION,
                active_workspace_id: id,
                workspaces: [this.createRecord(id, 'Personal')],
            });
        }

        let state: WorkspaceState & { version: number };

        try {
            state = JSON.parse(files.readText(this.indexPath));
        } catch {
            throw new WorkspaceError(
                'The local workspace index is not valid JSON.',
            );
        }

        if (
            state?.version !== VERSION ||
            typeof state.active_workspace_id !== 'string' ||
            !Array.isArray(state.workspaces) ||
            !state.workspaces.some(
                (workspace) => workspace.id === state.active_workspace_id,
            )
        ) {
            throw new WorkspaceError('The local workspace index is invalid.');
        }

        return state;
    }

    private write(state: WorkspaceState & { version?: number }): void {
        const files = this.host.files;
        const temporary = `${this.indexPath}.tmp-${uuidv7()}`;
        files.writeFile(
            temporary,
            `${JSON.stringify({ ...state, version: VERSION }, null, 4)}\n`,
        );
        files.rename(temporary, this.indexPath);
    }
}
