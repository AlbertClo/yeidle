<?php

namespace App\Models;

use App\Support\SystemNodes;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

class Node extends Model
{
    use HasUuids, SoftDeletes;

    protected $fillable = [
        'id',
        'parent_id',
        'position',
        'content',
        'tiptap_content',
        'is_checked',
        'modified_hlc',
    ];

    protected $attributes = [
        'modified_hlc' => '',
    ];

    // Sync bookkeeping — not part of the API surface
    protected $hidden = [
        'field_clocks',
        'purged',
    ];

    protected function casts(): array
    {
        return [
            'is_checked' => 'boolean',
            'tiptap_content' => 'array',
            'field_clocks' => 'array',
            'purged' => 'boolean',
        ];
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'parent_id');
    }

    public function children(): HasMany
    {
        return $this->hasMany(Node::class, 'parent_id')
            ->orderBy('position')
            ->orderBy('id');
    }

    public function outgoingLinks(): HasMany
    {
        return $this->hasMany(NodeLink::class, 'source_node_id');
    }

    public function incomingLinks(): HasMany
    {
        return $this->hasMany(NodeLink::class, 'target_node_id');
    }

    public function scopePages($query)
    {
        return $query
            ->whereNull('parent_id')
            ->whereNotIn('id', SystemNodes::ROOT_IDS);
    }

    public function scopeOrderedByModification(Builder $query): Builder
    {
        return $query->orderByDesc('modified_hlc')->orderByDesc('id');
    }

    public function isPage(): bool
    {
        return $this->parent_id === null;
    }

    /** Whether this node belongs to one of Yeidle's hidden system subtrees. */
    public function isSystemNode(): bool
    {
        $node = $this;
        $visited = [];

        while (true) {
            if (SystemNodes::isRoot($node->id)) {
                return true;
            }

            if ($node->parent_id === null || isset($visited[$node->id])) {
                return false;
            }

            $visited[$node->id] = true;
            $node = self::withTrashed()->find($node->parent_id);

            if ($node === null) {
                return false;
            }
        }
    }

    /**
     * Derived subtree visibility (sync design §5): deletion is stored
     * per-node and never cascaded at write time, so whether a node is
     * actually visible depends on its merged parent chain. Cycles (possible
     * under concurrent moves) are treated as unreachable — deterministic
     * and safe.
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
