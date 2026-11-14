<?php

use App\Models\User;
use Illuminate\Support\Facades\Broadcast;

Broadcast::channel(
    'workspaces.{workspaceId}.sync',
    fn (User $user, string $workspaceId): bool => $user->workspaces()
        ->whereKey($workspaceId)
        ->exists(),
);

/**
 * Who is on a page, and their cursors (client whispers; never stored). The
 * member info is what other clients see.
 */
Broadcast::channel(
    'workspaces.{workspaceId}.documents.{documentId}',
    fn (User $user, string $workspaceId, string $documentId): array|false => $user->workspaces()
        ->whereKey($workspaceId)
        ->exists()
        ? ['id' => (string) $user->getAuthIdentifier(), 'name' => $user->name]
        : false,
);
