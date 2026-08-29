<?php

namespace App\Services;

use App\Models\Node;
use Illuminate\Database\Eloquent\Collection as EloquentCollection;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

final class NodeTreeLoader
{
    public function load(Node $root): Node
    {
        $rows = DB::select(<<<'SQL'
            WITH RECURSIVE descendants AS (
                SELECT nodes.*
                FROM nodes
                WHERE nodes.parent_id = ?
                    AND nodes.deleted_at IS NULL

                UNION

                SELECT nodes.*
                FROM nodes
                INNER JOIN descendants ON nodes.parent_id = descendants.id
                WHERE nodes.deleted_at IS NULL
            )
            SELECT *
            FROM descendants
            ORDER BY parent_id, position, id
        SQL, [$root->id]);

        $descendants = Node::hydrate(array_map(
            fn (object $row): array => (array) $row,
            $rows,
        ))->reject(
            fn (Node $node): bool => $node->id === $root->id,
        );

        /** @var Collection<string, EloquentCollection<int, Node>> $childrenByParent */
        $childrenByParent = $descendants->groupBy('parent_id');
        $this->attachChildren($root, $childrenByParent, []);

        return $root;
    }

    /**
     * @param  Collection<string, EloquentCollection<int, Node>>  $childrenByParent
     * @param  array<string, true>  $ancestors
     */
    private function attachChildren(Node $node, $childrenByParent, array $ancestors): void
    {
        if (isset($ancestors[$node->id])) {
            $node->setRelation('children', new EloquentCollection);

            return;
        }

        $ancestors[$node->id] = true;
        $children = $childrenByParent->get($node->id, new EloquentCollection);
        $node->setRelation('children', $children);

        foreach ($children as $child) {
            $this->attachChildren($child, $childrenByParent, $ancestors);
        }
    }
}
