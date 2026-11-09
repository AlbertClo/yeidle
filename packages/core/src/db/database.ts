/**
 * The synchronous SQLite interface the core runs on. Desktop uses
 * node:sqlite; other hosts can use any synchronous SQLite (for example the
 * official WASM build in a worker).
 */

export type SqlValue = string | number | bigint | null | Uint8Array;

export type RunResult = { changes: number; lastInsertRowid: number };

export interface Database {
    all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
    get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
    run(sql: string, params?: unknown[]): RunResult;
    exec(sql: string): void;
    /** Runs fn atomically. Nested calls use savepoints. */
    transaction<T>(fn: () => T): T;
    close(): void;
}

/** Booleans and undefined aren't valid SQLite parameters. */
export function bind(params: unknown[] = []): SqlValue[] {
    return params.map((value) => {
        if (value === undefined || value === null) {
            return null;
        }

        if (typeof value === 'boolean') {
            return value ? 1 : 0;
        }

        if (
            typeof value === 'string' ||
            typeof value === 'number' ||
            typeof value === 'bigint' ||
            value instanceof Uint8Array
        ) {
            return value;
        }

        throw new TypeError(`Unsupported SQL parameter: ${typeof value}`);
    });
}

/** `?, ?, ?` for an IN list. */
export function placeholders(count: number): string {
    return new Array(count).fill('?').join(', ');
}
