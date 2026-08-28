<?php

namespace App\Workspaces;

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

final class CreateWorkspace
{
    public function create(User $owner, string $name, ?string $workspaceId = null): Workspace
    {
        return DB::transaction(function () use ($owner, $name, $workspaceId): Workspace {
            $workspace = $owner->ownedWorkspaces()->create(array_filter([
                'id' => $workspaceId,
                'name' => $name,
            ]));
            $workspace->members()->attach($owner->getKey(), ['role' => 'owner']);

            return $workspace;
        });
    }
}
