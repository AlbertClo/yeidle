<?php

namespace App\DailyNotes;

use App\Models\Node;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Support\Str;

final class DailyNoteService
{
    public function __construct(
        private readonly SyncService $sync,
    ) {}

    public function open(string $workspaceId, string $date): Node
    {
        $id = DailyNotes::pageId($workspaceId, $date);
        $existing = Node::withTrashed()->find($id);

        if ($existing?->isDailyNote() && ! $existing->trashed()) {
            return $existing;
        }

        $clock = new HlcGenerator('daily-'.Str::uuid7());

        $this->sync->push([[
            'op_id' => (string) Str::uuid7(),
            'client_id' => $clock->clientId,
            'hlc' => $clock->now(),
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $id,
                'fields' => [
                    'parent_id' => null,
                    'position' => 'a0',
                    'content' => DailyNotes::title($date),
                    'tiptap_content' => null,
                    'is_checked' => null,
                    'page_type' => DailyNotes::PAGE_TYPE,
                    'daily_note_date' => $date,
                ],
            ],
        ]]);

        return Node::findOrFail($id);
    }
}
