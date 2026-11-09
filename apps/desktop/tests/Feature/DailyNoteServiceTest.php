<?php

namespace Tests\Feature;

use App\DailyNotes\DailyNotes;
use App\DailyNotes\DailyNoteService;
use App\Models\Node;
use App\Sync\SyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class DailyNoteServiceTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_creates_one_deterministic_daily_page_per_workspace_and_date(): void
    {
        $workspaceId = (string) Str::uuid7();
        $service = app(DailyNoteService::class);

        $first = $service->open($workspaceId, '2026-08-30');
        $second = $service->open($workspaceId, '2026-08-30');

        $this->assertSame(DailyNotes::pageId($workspaceId, '2026-08-30'), $first->id);
        $this->assertSame($first->id, $second->id);
        $this->assertSame('August 30, 2026', $first->content);
        $this->assertSame('daily_note', $first->page_type);
        $this->assertSame('2026-08-30', $first->daily_note_date);
        $this->assertSame('2026-08-30', $first->created_at->format('Y-m-d'));
        $this->assertSame(1, Node::count());
        $this->assertSame(1, DB::table('document_updates')->count());
    }

    public function test_daily_page_ids_are_scoped_by_workspace(): void
    {
        $firstWorkspace = (string) Str::uuid7();
        $secondWorkspace = (string) Str::uuid7();

        $this->assertNotSame(
            DailyNotes::pageId($firstWorkspace, '2026-08-30'),
            DailyNotes::pageId($secondWorkspace, '2026-08-30'),
        );
    }

    public function test_opening_a_deleted_daily_note_restores_it(): void
    {
        $workspaceId = (string) Str::uuid7();
        $service = app(DailyNoteService::class);
        $page = $service->open($workspaceId, '2026-08-30');
        app(SyncService::class)->push([[
            'type' => 'node.delete',
            'payload' => ['id' => $page->id, 'page_id' => $page->id],
        ]]);
        $this->assertTrue($page->fresh()->trashed());

        $restored = $service->open($workspaceId, '2026-08-30');

        $this->assertSame($page->id, $restored->id);
        $this->assertFalse($restored->trashed());
    }
}
