<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class DeviceAuthorization extends Model
{
    use HasUuids;

    protected $guarded = [];

    /** @return BelongsTo<User, $this> */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    protected function casts(): array
    {
        return [
            'approved_at' => 'immutable_datetime',
            'consumed_at' => 'immutable_datetime',
            'expires_at' => 'immutable_datetime',
            'issued_token' => 'encrypted',
        ];
    }
}
