<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Projection row for media metadata; filename is the blob's content hash.
 *
 * @property string $id
 * @property string $workspace_id
 * @property string $filename
 * @property string $original_name
 * @property string $mime_type
 * @property int $size
 */
class Media extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $guarded = [];
}
