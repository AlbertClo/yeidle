import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type {
    Database as WasmDatabase,
    PreparedStatement,
} from '@sqlite.org/sqlite-wasm';
import { bind } from '@yeidle/core/db/database';
import type { Database, RunResult } from '@yeidle/core/db/database';

/**
 * SQLite for the core on Android: the official WebAssembly build, storing
 * its files in the origin-private file system through the "opfs-sahpool"
 * VFS. That VFS holds synchronous access handles, so it gives the core the
 * synchronous Database it expects, but only inside a worker, and needs no
 * cross-origin isolation headers.
 */

export type StoragePool = {
    open(path: string): Database;
    exists(path: string): boolean;
    unlink(path: string): void;
    fileNames(): string[];
};

export async function openStoragePool(): Promise<StoragePool> {
    const sqlite3 = await sqlite3InitModule();
    const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: 'yeidle',
        // Workspaces plus their journals; grows on demand below
        initialCapacity: 12,
    });
    const util = pool as typeof pool & { unlink(name: string): boolean };

    const ensureCapacity = async () => {
        if (pool.getFileCount() + 4 > pool.getCapacity()) {
            await pool.addCapacity(8);
        }
    };

    await ensureCapacity();

    return {
        open(path) {
            // Capacity is checked asynchronously; keep spare slots for the
            // next database and its journal
            void ensureCapacity();

            return wrap(new pool.OpfsSAHPoolDb(path), sqlite3);
        },
        exists: (path) => pool.getFileNames().includes(path),
        unlink: (path) => void util.unlink(path),
        fileNames: () => pool.getFileNames(),
    };
}

function wrap(
    db: WasmDatabase,
    sqlite3: Awaited<ReturnType<typeof sqlite3InitModule>>,
): Database {
    const statements = new Map<string, PreparedStatement>();
    let depth = 0;

    db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = DELETE;');

    const prepare = (sql: string, params: unknown[] | undefined) => {
        let statement = statements.get(sql);

        if (!statement) {
            statement = db.prepare(sql);
            statements.set(sql, statement);
        }

        statement.reset(true);
        const values = bind(params);

        if (values.length > 0) {
            statement.bind(values as never);
        }

        return statement;
    };

    const rows = <T>(
        sql: string,
        params?: unknown[],
        limit = Infinity,
    ): T[] => {
        const statement = prepare(sql, params);
        const result: T[] = [];

        try {
            while (result.length < limit && statement.step()) {
                result.push(statement.get({}) as T);
            }
        } finally {
            statement.reset();
        }

        return result;
    };

    return {
        all: <T>(sql: string, params?: unknown[]) => rows<T>(sql, params),
        get: <T>(sql: string, params?: unknown[]) => rows<T>(sql, params, 1)[0],
        run(sql: string, params?: unknown[]): RunResult {
            const statement = prepare(sql, params);

            try {
                statement.step();
            } finally {
                statement.reset();
            }

            return {
                changes: db.changes(),
                lastInsertRowid: Number(
                    sqlite3.capi.sqlite3_last_insert_rowid(db),
                ),
            };
        },
        exec(sql: string): void {
            db.exec(sql);
        },
        transaction<T>(fn: () => T): T {
            const savepoint = `sp_${depth}`;
            db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
            depth++;

            try {
                const result = fn();
                depth--;
                db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);

                return result;
            } catch (error) {
                depth--;
                db.exec(
                    depth === 0
                        ? 'ROLLBACK'
                        : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`,
                );
                throw error;
            }
        },
        close(): void {
            for (const statement of statements.values()) {
                statement.finalize();
            }

            statements.clear();
            db.close();
        },
    };
}
