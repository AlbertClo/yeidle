<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

/**
 * Projection row — written only by the op-apply function. Mirrors the
 * desktop schema plus workspace scoping.
 *
 * @property string $id
 * @property string $workspace_id
 * @property string|null $parent_id
 * @property string $position
 * @property string $content
 * @property array|null $tiptap_content
 * @property bool|null $is_checked
 * @property array<string, string>|null $field_clocks
 * @property bool $purged
 * @property string $modified_hlc
 */
class Node extends Model
{
    use SoftDeletes;

    public $incrementing = false;

    protected $keyType = 'string';

    protected $guarded = [];

    protected $attributes = [
        'modified_hlc' => '',
    ];

    protected $hidden = ['field_clocks', 'purged'];

    protected function casts(): array
    {
        return [
            'is_checked' => 'boolean',
            'tiptap_content' => 'array',
            'field_clocks' => 'array',
            'purged' => 'boolean',
        ];
    }

    /**
     * @return HasMany<Node, $this>
     */
    public function children(): HasMany
    {
        return $this->hasMany(self::class, 'parent_id')->orderBy('position');
    }

    /**
     * @return HasMany<NodeLink, $this>
     */
    public function outgoingLinks(): HasMany
    {
        return $this->hasMany(NodeLink::class, 'source_node_id');
    }

    /**
     * Derived subtree visibility (sync design §5): deletion is per-node,
     * reachability follows the merged parent chain; cycles are unreachable.
     */
    public function isReachable(): bool
    {
        $node = $this;
        $visited = [];

        while (true) {
            if ($node->purged || $node->trashed()) {
                return false;
            }

            if ($node->parent_id === null) {
                return true;
            }

            if (isset($visited[$node->id])) {
                return false;
            }

            $visited[$node->id] = true;
            $node = self::withTrashed()->find($node->parent_id);

            if (! $node) {
                return false;
            }
        }
    }
}
