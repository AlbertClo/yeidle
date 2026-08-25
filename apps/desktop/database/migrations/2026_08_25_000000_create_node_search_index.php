<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement(<<<'SQL'
            CREATE VIRTUAL TABLE node_search USING fts5(
                content,
                content = 'nodes',
                content_rowid = 'rowid',
                tokenize = 'trigram'
            )
        SQL);

        DB::unprepared(<<<'SQL'
            CREATE TRIGGER nodes_search_after_insert
            AFTER INSERT ON nodes
            WHEN new.deleted_at IS NULL AND new.purged = 0
            BEGIN
                INSERT INTO node_search(rowid, content)
                VALUES (new.rowid, new.content);
            END;
        SQL);

        DB::unprepared(<<<'SQL'
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
        SQL);

        DB::unprepared(<<<'SQL'
            CREATE TRIGGER nodes_search_after_delete
            AFTER DELETE ON nodes
            WHEN old.deleted_at IS NULL AND old.purged = 0
            BEGIN
                INSERT INTO node_search(node_search, rowid, content)
                VALUES ('delete', old.rowid, old.content);
            END;
        SQL);

        DB::statement(<<<'SQL'
            INSERT INTO node_search(rowid, content)
            SELECT rowid, content
            FROM nodes
            WHERE deleted_at IS NULL AND purged = 0
        SQL);
    }

    public function down(): void
    {
        DB::unprepared('DROP TRIGGER IF EXISTS nodes_search_after_delete');
        DB::unprepared('DROP TRIGGER IF EXISTS nodes_search_after_update');
        DB::unprepared('DROP TRIGGER IF EXISTS nodes_search_after_insert');
        DB::statement('DROP TABLE IF EXISTS node_search');
    }
};
