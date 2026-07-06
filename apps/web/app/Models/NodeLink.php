<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Derived projection: wikilink edges rebuilt from tiptap mentions by the
 * op-apply function.
 *
 * @property string $workspace_id
 * @property string $source_node_id
 * @property string $target_node_id
 * @property string|null $display_name
 */
class NodeLink extends Model
{
    protected $guarded = [];
}
