<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * One entry in a workspace's append-only op log.
 *
 * @property int $server_seq
 * @property string $workspace_id
 * @property string $op_id
 * @property string $client_id
 * @property int $user_id
 * @property string $hlc
 * @property string $type
 * @property array $payload
 */
class Op extends Model
{
    public $timestamps = false;

    protected $primaryKey = 'server_seq';

    protected $guarded = [];

    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'created_at' => 'datetime',
        ];
    }
}
