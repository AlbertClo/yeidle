<?php

namespace App\Models;

use Database\Factories\WorkspaceFactory;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\BelongsToMany;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * The unit of permissions and sync (sync design §14): one op log, one
 * cursor space, one membership. Users can own several.
 *
 * @property string $id
 * @property int $user_id
 * @property string $name
 */
class Workspace extends Model
{
    /** @use HasFactory<WorkspaceFactory> */
    use HasFactory, HasUuids;

    protected $fillable = ['id', 'name', 'user_id'];

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return BelongsToMany<User, $this>
     */
    public function members(): BelongsToMany
    {
        return $this->belongsToMany(User::class, 'workspace_memberships')
            ->withPivot('role')
            ->withTimestamps();
    }

    /**
     * @return HasMany<Op, $this>
     */
    public function ops(): HasMany
    {
        return $this->hasMany(Op::class);
    }

    /**
     * @return HasMany<Node, $this>
     */
    public function nodes(): HasMany
    {
        return $this->hasMany(Node::class);
    }
}
