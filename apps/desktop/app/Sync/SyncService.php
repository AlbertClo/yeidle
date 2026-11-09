<?php

namespace App\Sync;

use App\Documents\DocumentService;

/**
 * Entry point for node changes built in PHP (page creation, daily notes,
 * pins, collapsed nodes, preferences, imports). Changes keep the op shape
 * those producers already build — `type` plus a payload with `id`,
 * `page_id` and changed `fields` — and are written as Loro updates to the
 * owning page document.
 */
class SyncService
{
    public function __construct(
        private DocumentService $documents,
    ) {}

    /**
     * @param  array<int, array{type: string, payload: array}>  $ops
     * @return list<string> ids of the documents that changed
     */
    public function push(array $ops, string $message = ''): array
    {
        return $this->documents->applyNodeChanges($ops, $message);
    }
}
