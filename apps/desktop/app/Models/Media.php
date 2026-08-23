<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;

class Media extends Model
{
    use HasUuids;

    protected $fillable = [
        'filename',
        'original_name',
        'mime_type',
        'size',
        'cloud_uploaded_at',
    ];

    protected function casts(): array
    {
        return [
            'cloud_uploaded_at' => 'datetime',
        ];
    }

    public function isImage(): bool
    {
        return str_starts_with($this->mime_type, 'image/');
    }

    public function isVideo(): bool
    {
        return str_starts_with($this->mime_type, 'video/');
    }
}
