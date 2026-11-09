<?php

namespace App\Documents;

use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * One-time conversion of a workspace written by the op-log sync engine: every
 * top-level node becomes a Loro page document holding its live subtree, and
 * media metadata moves into the media document. Runs when a workspace has
 * nodes but no documents yet; re-running after a partial failure converts
 * only what is still missing.
 */
class LegacyMigration
{
    private const DOCUMENTS_PER_RUN = 100;

    public function __construct(
        private DocumentService $documents,
    ) {}

    public function needed(): bool
    {
        if (! DB::getSchemaBuilder()->hasTable('documents')) {
            return false;
        }

        return ! DB::table('documents')->exists()
            && DB::table('nodes')->where('purged', false)->exists();
    }

    /** @return int number of documents created */
    public function run(): int
    {
        $media = DB::table('media')->orderBy('id')->get();

        if ($media->isNotEmpty()) {
            $this->documents->apply([[
                'document_id' => DocumentService::MEDIA_DOCUMENT_ID,
                'media' => $media->map(fn ($row) => [
                    'id' => $row->id,
                    'hash' => $row->filename,
                    'original_name' => $row->original_name,
                    'mime_type' => $row->mime_type,
                    'size' => (int) $row->size,
                    'created_at' => (string) $row->created_at,
                ])->all(),
            ]], 'Migrated from the previous sync engine');
        }

        $nodes = DB::table('nodes')
            ->where('purged', false)
            ->orderBy('position')
            ->orderBy('id')
            ->get(['id', 'parent_id', 'position', 'content', 'tiptap_content', 'is_checked',
                'page_type', 'daily_note_date', 'created_at', 'deleted_at']);
        $children = $nodes->whereNotNull('parent_id')->groupBy('parent_id');
        $converted = DB::table('documents')->pluck('id')->flip();
        $actions = [];
        $count = 0;

        foreach ($nodes->whereNull('parent_id') as $page) {
            if ($converted->has($page->id) || $this->isLinkShell($page, $children)) {
                continue;
            }

            $actions[] = [
                'document_id' => $page->id,
                'replace' => [
                    'page' => [
                        'title' => $page->content,
                        'page_type' => $page->page_type === 'daily_note' ? 'daily_note' : null,
                        'daily_note_date' => $page->daily_note_date,
                        'created_at' => $page->created_at,
                        'deleted' => $page->deleted_at !== null,
                    ],
                    'blocks' => $this->subtree($page->id, $children),
                ],
            ];

            if (count($actions) === self::DOCUMENTS_PER_RUN) {
                $count += count($this->documents->apply($actions, 'Migrated from the previous sync engine'));
                $actions = [];
            }
        }

        if ($actions !== []) {
            $count += count($this->documents->apply($actions, 'Migrated from the previous sync engine'));
        }

        return $count;
    }

    /** Rows created only to satisfy a link's foreign key, never written to. */
    private function isLinkShell(object $page, Collection $children): bool
    {
        return $page->content === ''
            && $page->page_type === null
            && ! $children->has($page->id);
    }

    /** Live blocks under a node, nested, in sibling order. */
    private function subtree(string $parentId, Collection $children): array
    {
        $blocks = [];

        foreach ($children->get($parentId, collect()) as $row) {
            if ($row->deleted_at !== null) {
                continue;
            }

            $blocks[] = [
                'id' => $row->id,
                'parent_id' => $parentId,
                'position' => (string) $row->position,
                'content' => $row->content,
                'tiptap_content' => $row->tiptap_content === null
                    ? ($row->content === '' ? null : [
                        'type' => 'paragraph',
                        'content' => [['type' => 'text', 'text' => $row->content]],
                    ])
                    : json_decode($row->tiptap_content, true),
                'is_checked' => $row->is_checked === null ? null : (bool) $row->is_checked,
                'created_at' => $row->created_at,
                'children' => $this->subtree($row->id, $children),
            ];
        }

        return $blocks;
    }
}
