<?php

namespace App\Services;

use Illuminate\Support\Facades\DB;
use RuntimeException;

final class NodeTreeLoader
{
    /**
     * @return array{
     *     id: string,
     *     parent_id: ?string,
     *     position: string,
     *     content: string,
     *     tiptap_content: mixed,
     *     is_checked: ?bool,
     *     children: array
     * }
     */
    public function load(string $rootId): array
    {
        $rows = DB::select(<<<'SQL'
            WITH RECURSIVE subtree AS (
                SELECT id, parent_id, position, content, tiptap_content, is_checked
                FROM nodes
                WHERE id = ?
                    AND deleted_at IS NULL

                UNION

                SELECT nodes.id, nodes.parent_id, nodes.position, nodes.content,
                    nodes.tiptap_content, nodes.is_checked
                FROM nodes
                INNER JOIN subtree ON nodes.parent_id = subtree.id
                WHERE nodes.deleted_at IS NULL
            )
            SELECT *
            FROM subtree
            ORDER BY parent_id, position, id
        SQL, [$rootId]);

        $root = null;
        $childrenByParent = [];

        foreach ($rows as $row) {
            $node = $this->nodeFromRow($row);

            if ($node['id'] === $rootId) {
                $root = $node;

                continue;
            }

            $childrenByParent[$node['parent_id']][] = $node;
        }

        if ($root === null) {
            throw new RuntimeException("Node [{$rootId}] was not found.");
        }

        return $this->attachChildren($root, $childrenByParent, []);
    }

    /**
     * @return array{
     *     id: string,
     *     parent_id: ?string,
     *     position: string,
     *     content: string,
     *     tiptap_content: mixed,
     *     is_checked: ?bool,
     *     children: array
     * }
     */
    private function nodeFromRow(object $row): array
    {
        return [
            'id' => $row->id,
            'parent_id' => $row->parent_id,
            'position' => $row->position,
            'content' => $row->content,
            'tiptap_content' => $row->tiptap_content === null
                ? null
                : json_decode($row->tiptap_content, true),
            'is_checked' => $row->is_checked === null
                ? null
                : (bool) $row->is_checked,
            'children' => [],
        ];
    }

    /**
     * @param  array<string, list<array<string, mixed>>>  $childrenByParent
     * @param  array<string, true>  $ancestors
     * @return array<string, mixed>
     */
    private function attachChildren(array $node, array $childrenByParent, array $ancestors): array
    {
        if (isset($ancestors[$node['id']])) {
            $node['children'] = [];

            return $node;
        }

        $ancestors[$node['id']] = true;
        $node['children'] = array_map(
            fn (array $child): array => $this->attachChildren(
                $child,
                $childrenByParent,
                $ancestors,
            ),
            $childrenByParent[$node['id']] ?? [],
        );

        return $node;
    }
}
