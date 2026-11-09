<?php

namespace Tests\Feature\Sync;

use App\Documents\DocumentStore;
use App\Documents\LegacyMigration;
use App\Documents\LoroWorker;
use App\Models\Node;
use App\Models\NodeLink;
use App\Sync\SyncService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\TestCase;

class DocumentEndpointTest extends TestCase
{
    use RefreshDatabase;

    private function createPage(string $title): string
    {
        $id = (string) Str::uuid7();
        app(SyncService::class)->push([[
            'type' => 'node.set',
            'payload' => ['id' => $id, 'page_id' => $id, 'fields' => ['content' => $title]],
        ]]);

        return $id;
    }

    /**
     * An update as an editor would produce it: changes made against the
     * document's current state, without storing them.
     *
     * @param  list<array>  $changes
     */
    private function editorUpdate(string $documentId, array $changes): string
    {
        $state = app(DocumentStore::class)->load($documentId);
        $result = app(LoroWorker::class)->run([
            'documents' => [['id' => $documentId, 'snapshot' => $state['snapshot'], 'updates' => $state['updates']]],
            'actions' => [['document_id' => $documentId, 'changes' => $changes]],
        ]);

        return $result[0]['update'];
    }

    private function blockChange(string $pageId, string $id, string $text, string $position = 'a0', ?array $tiptap = null): array
    {
        return [
            'type' => 'node.set',
            'payload' => [
                'id' => $id,
                'page_id' => $pageId,
                'fields' => [
                    'parent_id' => $pageId,
                    'position' => $position,
                    'content' => $text,
                    'tiptap_content' => $tiptap ?? ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $text]]],
                ],
            ],
        ];
    }

    public function test_an_editor_update_is_stored_and_projected(): void
    {
        $pageId = $this->createPage('Inbox');
        $blockId = (string) Str::uuid7();
        $bytes = $this->editorUpdate($pageId, [$this->blockChange($pageId, $blockId, 'hello')]);

        $this->postJson("/api/documents/{$pageId}/updates", [
            'updates' => [['update_id' => (string) Str::uuid7(), 'client_id' => 'window-1', 'bytes' => $bytes]],
        ])->assertOk()->assertJsonStructure(['seq']);

        $block = Node::findOrFail($blockId);
        $this->assertSame('hello', $block->content);
        $this->assertSame($pageId, $block->parent_id);
        $this->assertSame($pageId, $block->document_id);
    }

    public function test_pushing_the_same_update_twice_is_a_no_op(): void
    {
        $pageId = $this->createPage('Inbox');
        $update = [
            'update_id' => (string) Str::uuid7(),
            'client_id' => 'window-1',
            'bytes' => $this->editorUpdate($pageId, [$this->blockChange($pageId, (string) Str::uuid7(), 'once')]),
        ];

        $first = $this->postJson("/api/documents/{$pageId}/updates", ['updates' => [$update]])->json('seq');
        $second = $this->postJson("/api/documents/{$pageId}/updates", ['updates' => [$update]])->json('seq');

        $this->assertSame($first, $second);
        $this->assertSame(2, DB::table('document_updates')->where('document_id', $pageId)->count());
    }

    public function test_concurrent_edits_from_two_windows_both_survive(): void
    {
        $pageId = $this->createPage('Inbox');
        // Both windows start from the same state and add different blocks
        $fromA = $this->editorUpdate($pageId, [$this->blockChange($pageId, (string) Str::uuid7(), 'from a', 'a0')]);
        $fromB = $this->editorUpdate($pageId, [$this->blockChange($pageId, (string) Str::uuid7(), 'from b', 'a1')]);

        foreach (['a' => $fromA, 'b' => $fromB] as $window => $bytes) {
            $this->postJson("/api/documents/{$pageId}/updates", [
                'updates' => [['update_id' => (string) Str::uuid7(), 'client_id' => "window-{$window}", 'bytes' => $bytes]],
            ])->assertOk();
        }

        $this->assertEqualsCanonicalizing(
            ['from a', 'from b'],
            Node::where('parent_id', $pageId)->pluck('content')->all(),
        );
    }

    public function test_show_and_updates_return_what_a_window_needs_to_catch_up(): void
    {
        $pageId = $this->createPage('Inbox');
        $loaded = $this->getJson("/api/documents/{$pageId}")->assertOk();
        $seq = $loaded->json('seq');
        $this->assertNotNull($loaded->json('snapshot'));

        app(SyncService::class)->push([$this->blockChange($pageId, (string) Str::uuid7(), 'later')]);

        $response = $this->getJson("/api/documents/{$pageId}/updates?since={$seq}")->assertOk();
        $this->assertCount(1, $response->json('updates'));
        $this->assertGreaterThan($seq, $response->json('seq'));

        $this->getJson("/api/documents/changes?since={$seq}")
            ->assertOk()
            ->assertJsonPath('documents.0.id', $pageId);
    }

    public function test_removed_blocks_are_soft_deleted_and_links_follow_content(): void
    {
        $pageId = $this->createPage('Inbox');
        $targetId = $this->createPage('Target');
        $blockId = (string) Str::uuid7();
        $mention = ['type' => 'paragraph', 'content' => [
            ['type' => 'text', 'text' => 'see '],
            ['type' => 'mention', 'attrs' => ['id' => $targetId, 'label' => 'Target']],
        ]];

        app(SyncService::class)->push([$this->blockChange($pageId, $blockId, 'see [[Target]]', 'a0', $mention)]);
        $this->assertSame(1, NodeLink::where('target_node_id', $targetId)->count());

        app(SyncService::class)->push([[
            'type' => 'node.delete',
            'payload' => ['id' => $blockId, 'page_id' => $pageId],
        ]]);

        $this->assertTrue(Node::withTrashed()->findOrFail($blockId)->trashed());
    }

    public function test_legacy_workspaces_are_converted_to_documents(): void
    {
        $pageId = (string) Str::uuid7();
        $parentId = (string) Str::uuid7();
        $childId = (string) Str::uuid7();
        $deletedId = (string) Str::uuid7();
        $rows = [
            [$pageId, null, 'a0', 'Legacy page', null, null],
            [$parentId, $pageId, 'a0', 'parent', null, null],
            [$childId, $parentId, 'a0', 'child', true, null],
            [$deletedId, $pageId, 'a1', 'gone', null, now()],
        ];

        foreach ($rows as [$id, $parent, $position, $content, $checked, $deletedAt]) {
            DB::table('nodes')->insert([
                'id' => $id,
                'parent_id' => $parent,
                'position' => $position,
                'content' => $content,
                'tiptap_content' => null,
                'is_checked' => $checked,
                'modified_hlc' => '',
                'purged' => false,
                'deleted_at' => $deletedAt,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
        }

        $migration = app(LegacyMigration::class);
        $this->assertTrue($migration->needed());
        $this->assertSame(1, $migration->run());
        $this->assertFalse($migration->needed());

        $this->assertSame($pageId, Node::findOrFail($childId)->document_id);
        $this->assertTrue(Node::findOrFail($childId)->is_checked);
        $this->assertSame('Legacy page', Node::findOrFail($pageId)->content);
        $this->assertTrue(Node::withTrashed()->findOrFail($deletedId)->trashed());
        $this->assertNotNull(app(DocumentStore::class)->load($pageId)['snapshot']);
    }
}
