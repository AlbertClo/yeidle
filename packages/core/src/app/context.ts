import type { Database } from '../db/database';
import type { DocumentService } from '../documents/service';

import type { Host } from './host';
import type { Workspace, Workspaces } from './workspaces';

/**
 * Everything a controller or service can reach. `workspace()` is the active
 * workspace; its database and documents change when the user switches.
 */
export type AppContext = {
    host: Host;
    workspaces: Workspaces;
    workspace(): Workspace;
    db(): Database;
    documents(): DocumentService;
    /** App-wide JSON settings (not per workspace), e.g. key bindings. */
    settings: Settings;
};

export interface Settings {
    get<T>(key: string): T | null;
    set(key: string, value: unknown): void;
}

export function createContext(host: Host, workspaces: Workspaces, settings: Settings): AppContext {
    return {
        host,
        workspaces,
        workspace: () => workspaces.active(),
        db: () => workspaces.active().db,
        documents: () => workspaces.active().documents,
        settings,
    };
}

/** Settings stored as one JSON file in the app data directory. */
export function fileSettings(host: Host, name = 'settings.json'): Settings {
    const path = host.files.join(host.dataDirectory, name);
    let cache: Record<string, unknown> | null = null;

    const load = (): Record<string, unknown> => {
        if (cache === null) {
            try {
                cache = host.files.exists(path) ? JSON.parse(host.files.readText(path)) : {};
            } catch {
                cache = {};
            }
        }

        return cache!;
    };

    return {
        get<T>(key: string): T | null {
            return (load()[key] as T | undefined) ?? null;
        },
        set(key: string, value: unknown): void {
            const data = load();

            if (value === null || value === undefined) {
                delete data[key];
            } else {
                data[key] = value;
            }

            host.files.mkdir(host.dataDirectory);
            host.files.writeFile(path, `${JSON.stringify(data, null, 4)}\n`);
        },
    };
}
