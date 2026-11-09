import { DatabaseSync } from 'node:sqlite';

import { bind } from './database';
import type { Database, RunResult } from './database';

/** node:sqlite (built into Node and Electron) as a core Database. */
export function openNodeDatabase(path: string, options: { readOnly?: boolean } = {}): Database {
    const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
    let depth = 0;

    if (!options.readOnly) {
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA foreign_keys = ON;');
    }

    db.exec('PRAGMA busy_timeout = 5000;');

    const statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
    const prepare = (sql: string) => {
        let statement = statements.get(sql);

        if (!statement) {
            statement = db.prepare(sql);
            statements.set(sql, statement);
        }

        return statement;
    };

    return {
        all<T>(sql: string, params?: unknown[]): T[] {
            return prepare(sql).all(...bind(params)) as T[];
        },
        get<T>(sql: string, params?: unknown[]): T | undefined {
            return prepare(sql).get(...bind(params)) as T | undefined;
        },
        run(sql: string, params?: unknown[]): RunResult {
            const result = prepare(sql).run(...bind(params));

            return {
                changes: Number(result.changes),
                lastInsertRowid: Number(result.lastInsertRowid),
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
            statements.clear();
            db.close();
        },
    };
}
