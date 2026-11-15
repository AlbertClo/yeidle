import type { Database } from './database';

/**
 * Workspace database schema, built by numbered steps (see MIGRATIONS).
 */

const CONTENT_TABLES = `
CREATE TABLE IF NOT EXISTS "nodes" (
    "id" varchar not null primary key,
    "parent_id" varchar references "nodes"("id") on delete cascade,
    "position" varchar not null default 'a0',
    "content" text not null default (''),
    "is_checked" tinyint(1),
    "created_at" datetime,
    "updated_at" datetime,
    "deleted_at" datetime,
    "tiptap_content" text,
    "field_clocks" text,
    "purged" tinyint(1) not null default '0',
    "modified_hlc" text not null default '',
    "page_type" varchar,
    "daily_note_date" date,
    "document_id" varchar
);
CREATE INDEX IF NOT EXISTS "nodes_parent_id_index" on "nodes" ("parent_id");
CREATE INDEX IF NOT EXISTS "nodes_page_order_index" on "nodes" ("parent_id", "deleted_at", "modified_hlc", "id");
CREATE INDEX IF NOT EXISTS "nodes_page_type_daily_note_date_index" on "nodes" ("page_type", "daily_note_date");

CREATE TABLE IF NOT EXISTS "node_links" (
    "id" varchar not null primary key,
    "source_node_id" varchar not null references "nodes"("id") on delete cascade,
    "target_node_id" varchar not null references "nodes"("id") on delete cascade,
    "display_name" varchar,
    "created_at" datetime,
    "deleted_at" datetime
);
CREATE UNIQUE INDEX IF NOT EXISTS "node_links_source_node_id_target_node_id_unique" on "node_links" ("source_node_id", "target_node_id");
CREATE INDEX IF NOT EXISTS "node_links_target_node_id_index" on "node_links" ("target_node_id");

CREATE TABLE IF NOT EXISTS "page_visits" (
    "id" varchar not null primary key,
    "node_id" varchar not null references "nodes"("id") on delete cascade,
    "visited_at" datetime not null
);
CREATE INDEX IF NOT EXISTS "page_visits_node_id_visited_at_index" on "page_visits" ("node_id", "visited_at");

CREATE TABLE IF NOT EXISTS "media" (
    "id" varchar not null primary key,
    "filename" varchar not null,
    "original_name" varchar not null,
    "mime_type" varchar not null,
    "size" integer not null,
    "created_at" datetime,
    "updated_at" datetime,
    "cloud_uploaded_at" datetime
);

CREATE TABLE IF NOT EXISTS "sync_state" (
    "id" integer primary key autoincrement not null,
    "client_id" varchar not null,
    "last_server_seq" integer not null default '0',
    "cloud_url" varchar,
    "cloud_token" text,
    "last_sync_attempt_at" datetime,
    "last_sync_success_at" datetime,
    "last_sync_error" text,
    "workspace_id" varchar,
    "cloud_seed_pending" tinyint(1) not null default '0',
    "cloud_user_id" varchar
);

CREATE TABLE IF NOT EXISTS "navigation_locations" (
    "id" varchar not null primary key,
    "profile_key" varchar not null,
    "parent_id" varchar,
    "url" varchar not null,
    "page_id" varchar,
    "block_id" varchar,
    "cursor_offset" integer,
    "selection_type" varchar,
    "scroll_top" integer not null default '0',
    "visited_at" datetime not null,
    "last_visited_at" datetime not null,
    "created_at" datetime,
    "updated_at" datetime
);
CREATE INDEX IF NOT EXISTS "navigation_locations_profile_key_parent_id_index" on "navigation_locations" ("profile_key", "parent_id");
CREATE INDEX IF NOT EXISTS "navigation_locations_profile_key_last_visited_at_index" on "navigation_locations" ("profile_key", "last_visited_at");
CREATE TABLE IF NOT EXISTS "navigation_history_states" (
    "profile_key" varchar not null primary key,
    "current_location_id" varchar,
    "created_at" datetime,
    "updated_at" datetime
);
`;

const SEARCH_INDEX = `
CREATE VIRTUAL TABLE node_search USING fts5(
    content,
    content = 'nodes',
    content_rowid = 'rowid',
    tokenize = 'trigram'
);
CREATE TRIGGER nodes_search_after_insert
    AFTER INSERT ON nodes
    WHEN new.deleted_at IS NULL AND new.purged = 0
    BEGIN
        INSERT INTO node_search(rowid, content)
        VALUES (new.rowid, new.content);
    END;
CREATE TRIGGER nodes_search_after_update
    AFTER UPDATE OF content, deleted_at, purged ON nodes
    BEGIN
        INSERT INTO node_search(node_search, rowid, content)
        SELECT 'delete', old.rowid, old.content
        WHERE old.deleted_at IS NULL AND old.purged = 0;

        INSERT INTO node_search(rowid, content)
        SELECT new.rowid, new.content
        WHERE new.deleted_at IS NULL AND new.purged = 0;
    END;
CREATE TRIGGER nodes_search_after_delete
    AFTER DELETE ON nodes
    WHEN old.deleted_at IS NULL AND old.purged = 0
    BEGIN
        INSERT INTO node_search(node_search, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;
`;

const DOCUMENT_TABLES = `
CREATE TABLE IF NOT EXISTS "documents" (
    "id" varchar not null primary key,
    "snapshot" blob,
    "snapshot_seq" integer not null default '0',
    "updated_at" datetime
);
CREATE TABLE IF NOT EXISTS "document_updates" (
    "id" integer primary key autoincrement not null,
    "document_id" varchar not null,
    "update_id" varchar not null,
    "client_id" varchar not null,
    "bytes" blob not null,
    "cloud_seq" integer,
    "created_at" datetime
);
CREATE INDEX IF NOT EXISTS "document_updates_document_id_index" on "document_updates" ("document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "document_updates_update_id_unique" on "document_updates" ("update_id");
CREATE INDEX IF NOT EXISTS "document_updates_cloud_seq_index" on "document_updates" ("cloud_seq");
`;

function hasTable(db: Database, name: string): boolean {
    return (
        db.get(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
            [name],
        ) !== undefined
    );
}

function hasColumn(db: Database, table: string, column: string): boolean {
    return db
        .all<{ name: string }>(`PRAGMA table_info("${table}")`)
        .some((row) => row.name === column);
}

/**
 * Schema steps, applied in order. Step N brings a database to version N
 * (stored in PRAGMA user_version). Append new steps; never edit old ones.
 */
const MIGRATIONS: ((db: Database) => void)[] = [
    // 1: the NativePHP app's tables (so its workspace files open unchanged)
    // plus the Loro document tables
    (db) => {
        db.exec(CONTENT_TABLES);

        if (!hasTable(db, 'node_search')) {
            db.exec(SEARCH_INDEX);
            db.exec("INSERT INTO node_search(node_search) VALUES ('rebuild')");
        }

        // NativePHP workspaces from before the document engine
        if (!hasColumn(db, 'nodes', 'document_id')) {
            db.exec('ALTER TABLE "nodes" ADD COLUMN "document_id" varchar');
        }

        db.exec(
            'CREATE INDEX IF NOT EXISTS "nodes_document_id_index" on "nodes" ("document_id")',
        );
        db.exec(DOCUMENT_TABLES);
    },

    // 2: cloud pairings from the operation-log era point at a log of ops,
    // not document updates; the workspace pairs again from scratch
    (db) => {
        db.exec(`UPDATE sync_state SET
            cloud_url = NULL,
            cloud_token = NULL,
            workspace_id = NULL,
            last_server_seq = 0,
            cloud_seed_pending = 0,
            last_sync_attempt_at = NULL,
            last_sync_success_at = NULL,
            last_sync_error = NULL`);
        db.exec('UPDATE document_updates SET cloud_seq = NULL');
    },

    // 3: nodes.modified_hlc held a hybrid logical clock in the operation-log
    // era and a clock-shaped stamp since; it becomes a plain timestamp with
    // milliseconds (ISO 8601, so text order is time order). Values written
    // in either old format start with 15 digits of milliseconds.
    (db) => {
        if (hasColumn(db, 'nodes', 'modified_hlc')) {
            db.exec(
                'ALTER TABLE "nodes" RENAME COLUMN "modified_hlc" TO "modified_at"',
            );
        }

        db.exec(`UPDATE nodes SET modified_at = strftime(
                '%Y-%m-%dT%H:%M:%fZ',
                CAST(substr(modified_at, 1, 15) AS INTEGER) / 1000.0,
                'unixepoch'
            )
            WHERE modified_at GLOB '${'[0-9]'.repeat(15)}*'`);
    },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** Brings a workspace database (new, or written by the NativePHP app) to the current schema. */
export function migrate(db: Database): void {
    let version = db.get<{ user_version: number }>(
        'PRAGMA user_version',
    )!.user_version;

    for (; version < MIGRATIONS.length; version++) {
        db.transaction(() => {
            MIGRATIONS[version](db);
            db.exec(`PRAGMA user_version = ${version + 1}`);
        });
    }
}
