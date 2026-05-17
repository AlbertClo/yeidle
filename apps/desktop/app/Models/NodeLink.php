<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\SoftDeletes;

class NodeLink extends Model
{
    use HasUuids, SoftDeletes;

    const UPDATED_AT = null;

    protected $fillable = [
        'source_node_id',
        'target_node_id',
        'display_name',
    ];

    public function sourceNode(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'source_node_id');
    }

    public function targetNode(): BelongsTo
    {
        return $this->belongsTo(Node::class, 'target_node_id');
    }
}
