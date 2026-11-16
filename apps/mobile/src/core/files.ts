import type { Database } from '@yeidle/core/db/database';
import type { Files } from '@yeidle/core/app/host';

import type { StoragePool } from './sqlite';

/**
 * The core's Files interface in the WebView: small files (workspace index,
 * settings, account, media) are rows in one SQLite table, since a worker
 * has no synchronous file system. Directories are implied by paths.
 * Workspace databases live in the storage pool itself, so operations on
 * them go to the pool.
 */
export function sqliteFiles(db: Database, pool: StoragePool): Files {
    db.exec(`CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        data BLOB NOT NULL
    ) WITHOUT ROWID`);

    const isDatabase = (path: string) =>
        /\.sqlite(-journal|-wal|-shm)?$/.test(path) ||
        /\.sqlite(\.\d+)?\.old$/.test(path);

    const read = (path: string): Uint8Array => {
        const row = db.get<{ data: Uint8Array }>(
            'SELECT data FROM files WHERE path = ?',
            [normalize(path)],
        );

        if (!row) {
            throw new Error(`ENOENT: no such file, open '${path}'`);
        }

        return row.data;
    };

    const isFile = (path: string) =>
        isDatabase(path)
            ? pool.exists(normalize(path))
            : db.get('SELECT 1 FROM files WHERE path = ?', [
                  normalize(path),
              ]) !== undefined;

    const isDirectory = (path: string) => {
        const prefix = `${normalize(path).replace(/\/$/, '')}/`;

        return (
            db.get('SELECT 1 FROM files WHERE path >= ? AND path < ? LIMIT 1', [
                prefix,
                `${prefix}￿`,
            ]) !== undefined ||
            pool.fileNames().some((name) => name.startsWith(prefix))
        );
    };

    const write = (path: string, data: Uint8Array | string) => {
        db.run(
            'INSERT INTO files (path, data) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET data = excluded.data',
            [
                normalize(path),
                typeof data === 'string'
                    ? new TextEncoder().encode(data)
                    : data,
            ],
        );
    };

    return {
        exists: (path) => isFile(path) || isDirectory(path),
        isFile,
        isDirectory,
        readFile: read,
        readText: (path) => new TextDecoder().decode(read(path)),
        writeFile: write,
        appendFile(path, data) {
            const existing = isFile(path) ? read(path) : new Uint8Array();
            const combined = new Uint8Array(existing.length + data.length);
            combined.set(existing);
            combined.set(data, existing.length);
            write(path, combined);
        },
        // Directories exist as soon as something is written under them
        mkdir: () => undefined,
        rename(from, to) {
            if (isDatabase(from)) {
                throw new Error(
                    'Moving a workspace database is not supported on Android yet.',
                );
            }

            db.transaction(() => {
                write(to, read(from));
                db.run('DELETE FROM files WHERE path = ?', [normalize(from)]);
            });
        },
        link(from, to) {
            write(to, read(from));
        },
        copy(from, to) {
            write(to, read(from));
        },
        unlink(path) {
            if (isDatabase(path)) {
                if (pool.exists(normalize(path))) {
                    pool.unlink(normalize(path));
                }

                return;
            }

            db.run('DELETE FROM files WHERE path = ?', [normalize(path)]);
        },
        removeDirectory(path) {
            const prefix = `${normalize(path).replace(/\/$/, '')}/`;
            db.run('DELETE FROM files WHERE path >= ? AND path < ?', [
                prefix,
                `${prefix}￿`,
            ]);

            for (const name of pool.fileNames()) {
                if (name.startsWith(prefix)) {
                    pool.unlink(name);
                }
            }
        },
        size: (path) => read(path).length,
        list(path) {
            const prefix = `${normalize(path).replace(/\/$/, '')}/`;
            const names = new Set<string>();

            for (const candidate of [
                ...db
                    .all<{ path: string }>(
                        'SELECT path FROM files WHERE path >= ? AND path < ?',
                        [prefix, `${prefix}￿`],
                    )
                    .map((row) => row.path),
                ...pool.fileNames().filter((name) => name.startsWith(prefix)),
            ]) {
                names.add(candidate.slice(prefix.length).split('/')[0]);
            }

            return [...names];
        },
        join: (...parts) => normalize(parts.join('/')),
        dirname: (path) => {
            const normalized = normalize(path);
            const at = normalized.lastIndexOf('/');

            return at <= 0 ? '/' : normalized.slice(0, at);
        },
        basename: (path) => normalize(path).split('/').pop() ?? '',
    };
}

/** Absolute POSIX path with `.` and `..` resolved and no duplicate slashes. */
function normalize(path: string): string {
    const parts: string[] = [];

    for (const part of path.split('/')) {
        if (part === '' || part === '.') {
            continue;
        }

        if (part === '..') {
            parts.pop();
        } else {
            parts.push(part);
        }
    }

    return `/${parts.join('/')}`;
}
