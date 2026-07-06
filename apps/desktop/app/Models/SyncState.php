<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * Single-row table: this installation's sync identity and cloud pairing.
 */
class SyncState extends Model
{
    public $timestamps = false;

    protected $table = 'sync_state';

    protected $guarded = [];

    public static function current(): ?self
    {
        return self::query()->first();
    }
}
