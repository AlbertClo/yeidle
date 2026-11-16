import type { Files } from '../app/host';

import type { Database } from './database';

/**
 * The workspace database (docs/database-design.md): document storage, a read
 * model rebuilt from the documents, and this device's own state.
 */

const STORAGE = `
CREATE TABLE documents (
    id            TEXT PRIMARY KEY,
    snapshot      BLOB,
    snapshot_seq  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE document_updates (
    seq           INTEGER PRIMARY KEY,
    document_id   TEXT NOT NULL REFERENCES documents(id),
    update_id     TEXT NOT NULL UNIQUE,
    origin        TEXT NOT NULL,
    bytes         BLOB NOT NULL,
    cloud_seq     INTEGER,
    created_at    INTEGER NOT NULL
);
CREATE INDEX document_updates_document ON document_updates (document_id, seq);
CREATE INDEX document_updates_outbox ON document_updates (seq) WHERE cloud_seq IS NULL;
`;

const READ_MODEL = `
CREATE TABLE pages (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL COLLATE NOCASE,
    kind        TEXT NOT NULL DEFAULT 'page' CHECK (kind IN ('page', 'daily')),
    daily_date  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX pages_recent ON pages (updated_at, id);
CREATE INDEX pages_title ON pages (title);

CREATE TABLE blocks (
    search_id  INTEGER PRIMARY KEY,
    id         TEXT NOT NULL UNIQUE,
    page_id    TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    text       TEXT NOT NULL
);
CREATE INDEX blocks_page ON blocks (page_id);

CREATE TABLE links (
    source_block_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
    target_id        TEXT NOT NULL,
    PRIMARY KEY (source_block_id, target_id)
) WITHOUT ROWID;
CREATE INDEX links_target ON links (target_id);

CREATE VIRTUAL TABLE block_search USING fts5(
    text, content = 'blocks', content_rowid = 'search_id', tokenize = 'trigram'
);

CREATE TABLE media (
    id             TEXT PRIMARY KEY,
    hash           TEXT NOT NULL,
    original_name  TEXT NOT NULL,
    mime_type      TEXT NOT NULL,
    size           INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
);
CREATE INDEX media_hash ON media (hash);
`;

const DEVICE_STATE = `
CREATE TABLE meta (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE uploaded_blobs (
    hash  TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE navigation_locations (
    id              TEXT PRIMARY KEY,
    user_key        TEXT NOT NULL,
    parent_id       TEXT,
    url             TEXT NOT NULL,
    page_id         TEXT,
    block_id        TEXT,
    cursor_offset   INTEGER,
    selection_type  TEXT,
    scroll_top      INTEGER NOT NULL DEFAULT 0,
    visited_at      INTEGER NOT NULL,
    last_visited_at INTEGER NOT NULL
);
CREATE INDEX navigation_tree ON navigation_locations (user_key, parent_id);
CREATE INDEX navigation_recent ON navigation_locations (user_key, last_visited_at);

CREATE TABLE navigation_current (
    user_key     TEXT PRIMARY KEY,
    location_id  TEXT
) WITHOUT ROWID;
`;

/**
 * Bumped on every schema change. Until launch there are no migrations: a
 * database with another version is set aside and a new one created.
 */
export const SCHEMA_VERSION = 4;

/**
 * Bumped when what the projector writes changes (e.g. how block text is
 * derived). A workspace whose read model was built by another version
 * rebuilds it from the documents when it opens.
 */
export const READ_MODEL_VERSION = 3;

/** The tables rebuilt from the documents. */
export const READ_MODEL_TABLES = ['links', 'blocks', 'pages', 'media'];

function version(db: Database): number {
    return db.get<{ user_version: number }>('PRAGMA user_version')!
        .user_version;
}

function isEmpty(db: Database): boolean {
    return db.get('SELECT 1 FROM sqlite_master LIMIT 1') === undefined;
}

/** Creates the schema in an empty database. */
export function createSchema(db: Database): void {
    db.transaction(() => {
        db.exec(STORAGE);
        db.exec(READ_MODEL);
        db.exec(DEVICE_STATE);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
}

/**
 * Opens a workspace database at the current schema. A database from another
 * schema version is renamed to `<name>.old` (never deleted) and replaced with
 * a new one. Returns the database and the path it was moved to, if any.
 */
export function openWorkspaceDatabase(
    open: (path: string) => Database,
    files: Files,
    path: string,
): { db: Database; setAside: string | null } {
    let db = open(path);
    let setAside: string | null = null;

    if (version(db) !== SCHEMA_VERSION && !isEmpty(db)) {
        // Fold the write-ahead log in, so the renamed file is complete
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
        setAside = `${path}.old`;

        for (let n = 2; files.exists(setAside); n++) {
            setAside = `${path}.${n}.old`;
        }

        files.rename(path, setAside);

        for (const suffix of ['-wal', '-shm']) {
            files.unlink(path + suffix);
        }

        db = open(path);
    }

    if (isEmpty(db)) {
        createSchema(db);
    }

    return { db, setAside };
}
