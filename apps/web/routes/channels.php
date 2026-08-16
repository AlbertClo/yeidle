<?php

use App\Models\User;
use Illuminate\Support\Facades\Broadcast;

Broadcast::channel(
    'workspaces.{workspaceId}.sync',
    fn (User $user, string $workspaceId): bool => $user->workspaces()
        ->whereKey($workspaceId)
        ->exists(),
);
