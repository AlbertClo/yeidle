<?php

namespace App\Models;

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
    ];

    protected function casts(): array
    {
        return [
            'is_checked' => 'boolean',
            'tiptap_content' => 'array',
        ];
    }

    public function parent(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'parent_id');
    }

    public function children(): HasMany
    {
        return $this->hasMany(Node::class, 'parent_id')->orderBy('position');
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
        return $query->whereNull('parent_id');
    }

    public function isPage(): bool
    {
        return $this->parent_id === null;
    }
}
