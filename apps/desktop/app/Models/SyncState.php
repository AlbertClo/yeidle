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

    protected function casts(): array
    {
        return [
            'cloud_seed_pending' => 'boolean',
            'last_sync_attempt_at' => 'datetime',
            'last_sync_success_at' => 'datetime',
        ];
    }

    public static function current(): ?self
    {
        return self::query()->first();
    }
}
