<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;

final class BacklinkLoader
{
    /**
     * @return list<array{id: string, page_id: string, page_title: string}>
     */
    public function load(string $targetNodeId): array
    {
        $rows = DB::select(<<<'SQL'
            WITH RECURSIVE ancestors AS (
                SELECT node_links.id AS link_id, nodes.id AS node_id,
                    nodes.parent_id, nodes.content
                FROM node_links
                INNER JOIN nodes ON nodes.id = node_links.source_node_id
                WHERE node_links.target_node_id = ?
                    AND node_links.deleted_at IS NULL
                    AND nodes.deleted_at IS NULL

                UNION

                SELECT ancestors.link_id, parents.id, parents.parent_id,
                    parents.content
                FROM ancestors
                INNER JOIN nodes AS parents ON parents.id = ancestors.parent_id
                WHERE parents.deleted_at IS NULL
            )
            SELECT link_id AS id, node_id AS page_id, content AS page_title
            FROM ancestors
            WHERE parent_id IS NULL
            ORDER BY link_id
        SQL, [$targetNodeId]);

        $backlinks = [];
        $seenPages = [];

        foreach ($rows as $row) {
            if (isset($seenPages[$row->page_id])) {
                continue;
            }

            $seenPages[$row->page_id] = true;
            $backlinks[] = [
                'id' => $row->id,
                'page_id' => $row->page_id,
                'page_title' => $row->page_title ?: '[untitled]',
            ];
        }

        return $backlinks;
    }
}
