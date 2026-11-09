<?php

namespace App\Documents;

use App\Models\NodeLink;
use App\Services\LinkParser;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Writes a document's projected rows (from the Loro worker) into the SQLite
 * read model: nodes, node_links and media. Only rows that differ are
 * written, and blocks that left the document are soft-deleted. This is the
 * only writer of those tables.
 */
class Projector
{
    public function __construct(
        private LinkParser $linkParser = new LinkParser,
    ) {}

    /**
     * @param  array{page: ?array, blocks: list<array>, media: list<array>}  $rows
     * @return bool whether anything changed
     */
    public function write(string $documentId, array $rows): bool
    {
        $now = Carbon::now();
        $modified = self::modifiedClock($now);
        $changed = false;

        foreach ($rows['media'] ?? [] as $media) {
            $changed = $this->writeMedia($media) || $changed;
        }

        if (($rows['page'] ?? null) === null) {
            return $changed;
        }

        $existing = DB::table('nodes')
            ->where('document_id', $documentId)
            ->orWhere('id', $documentId)
            ->get()
            ->keyBy('id');
        $blockIds = array_column($rows['blocks'], 'id');

        if ($blockIds !== []) {
            // Rows from before the document existed (or claimed by link
            // shells) still need comparing against
            foreach (array_chunk($blockIds, 500) as $chunk) {
                foreach (DB::table('nodes')->whereIn('id', $chunk)->whereNull('document_id')->get() as $row) {
                    $existing[$row->id] = $row;
                }
            }
        }

        $page = $rows['page'];
        $pageExists = $existing->has($documentId);

        if ($page['has_meta'] || $pageExists || $rows['blocks'] !== []) {
            $old = $existing->get($documentId);
            $createdAt = $this->pageCreatedAt($page, $old, $now);
            $data = [
                'id' => $documentId,
                'parent_id' => null,
                'position' => 'a0',
                'content' => $page['content'],
                'tiptap_content' => null,
                'is_checked' => null,
                'page_type' => $page['page_type'],
                'daily_note_date' => $page['daily_note_date'],
                'deleted_at' => $page['deleted'] ? ($old->deleted_at ?? $now) : null,
                'document_id' => $documentId,
            ];

            if ($old === null || $this->differs($old, $data) || ($old->created_at ?? null) !== $createdAt) {
                $this->upsert($data + ['created_at' => $createdAt], $old, $now);
                $changed = true;
            }
        }

        $blocksChanged = false;

        foreach ($rows['blocks'] as $block) {
            $old = $existing->get($block['id']);
            $data = [
                'id' => $block['id'],
                'parent_id' => $block['parent_id'],
                'position' => $block['position'],
                'content' => $block['content'],
                'tiptap_content' => $block['tiptap_content'],
                'is_checked' => $block['is_checked'],
                'page_type' => null,
                'daily_note_date' => null,
                'deleted_at' => null,
                'document_id' => $documentId,
            ];

            if ($old !== null && ! $this->differs($old, $data)) {
                continue;
            }

            $this->upsert(
                $data + ['created_at' => $old->created_at ?? $this->timestamp($block['created_at'] ?? null) ?? $now->format('Y-m-d H:i:s')],
                $old,
                $now,
                $modified,
            );

            if ($old === null
                || $old->deleted_at !== null
                || ! $this->sameJson($old->tiptap_content, $block['tiptap_content'])) {
                $this->rebuildLinks($block['id'], $block['tiptap_content']);
            }

            $blocksChanged = true;
        }

        $live = array_flip($blockIds);

        foreach ($existing as $id => $row) {
            if ($id === $documentId || isset($live[$id]) || $row->deleted_at !== null
                || $row->document_id !== $documentId) {
                continue;
            }

            DB::table('nodes')->where('id', $id)->update([
                'deleted_at' => $now,
                'modified_hlc' => $modified,
                'updated_at' => $now,
            ]);
            $blocksChanged = true;
        }

        if ($blocksChanged || $changed) {
            DB::table('nodes')->where('id', $documentId)->update(['modified_hlc' => $modified]);
        }

        return $changed || $blocksChanged;
    }

    /**
     * Sortable modification stamp. Keeps the old HLC column's ordering
     * format (15-digit milliseconds first) so existing ORDER BYs still work.
     */
    public static function modifiedClock(Carbon $at): string
    {
        return str_pad((string) $at->getTimestampMs(), 15, '0', STR_PAD_LEFT).'-0000-local';
    }

    private function upsert(array $data, ?object $old, Carbon $now, ?string $modified = null): void
    {
        $data['tiptap_content'] = $data['tiptap_content'] === null
            ? null
            : json_encode($data['tiptap_content'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $data['is_checked'] = $data['is_checked'] === null ? null : (int) $data['is_checked'];
        $data['updated_at'] = $now;
        $data['modified_hlc'] = $modified ?? self::modifiedClock($now);

        if ($old === null) {
            DB::table('nodes')->insert($data + ['purged' => false]);

            return;
        }

        DB::table('nodes')->where('id', $data['id'])->update($data);
    }

    private function differs(object $old, array $data): bool
    {
        foreach ($data as $key => $value) {
            $current = $old->{$key} ?? null;

            if ($key === 'tiptap_content') {
                if (! $this->sameJson($current, $value)) {
                    return true;
                }

                continue;
            }

            if ($key === 'is_checked') {
                if (($current === null ? null : (bool) $current) !== $value) {
                    return true;
                }

                continue;
            }

            if ($key === 'deleted_at') {
                if (($current === null) !== ($value === null)) {
                    return true;
                }

                continue;
            }

            if ($current !== $value && (string) $current !== (string) $value) {
                return true;
            }

            if ($current === null && $value !== null) {
                return true;
            }
        }

        return false;
    }

    private function sameJson(mixed $stored, mixed $value): bool
    {
        $decoded = is_string($stored) ? json_decode($stored, true) : $stored;

        return $decoded == $value && ($decoded === null) === ($value === null);
    }

    private function pageCreatedAt(array $page, ?object $old, Carbon $now): string
    {
        if ($page['page_type'] === 'daily_note' && is_string($page['daily_note_date'])) {
            return $page['daily_note_date'].' 00:00:00';
        }

        return $this->timestamp($page['created_at'] ?? null)
            ?? $old->created_at
            ?? $now->format('Y-m-d H:i:s');
    }

    private function timestamp(?string $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        try {
            return Carbon::parse($value)->utc()->format('Y-m-d H:i:s');
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * node_links is derived from UUID-based mentions in the block's content.
     * Link targets that don't exist yet get shell rows so the foreign key
     * holds; their own document fills them in when it arrives.
     */
    private function rebuildLinks(string $nodeId, mixed $tiptapContent): void
    {
        DB::table('node_links')->where('source_node_id', $nodeId)->delete();

        if (! is_array($tiptapContent)) {
            return;
        }

        $links = [];

        foreach ($this->linkParser->extractMentions($tiptapContent) as $mention) {
            if (is_string($mention['id']) && Str::isUuid($mention['id'])) {
                $links[$mention['id']] = $mention['label'] ?? null;
            }
        }

        ksort($links);

        foreach ($links as $targetId => $label) {
            DB::table('nodes')->insertOrIgnore([
                'id' => $targetId,
                'content' => '',
                'position' => 'a0',
                'modified_hlc' => '',
                'purged' => false,
                'created_at' => now(),
                'updated_at' => now(),
            ]);
            NodeLink::create([
                'source_node_id' => $nodeId,
                'target_node_id' => $targetId,
                'display_name' => $label,
            ]);
        }
    }

    private function writeMedia(array $media): bool
    {
        if (DB::table('media')->where('id', $media['id'])->exists()) {
            return false;
        }

        DB::table('media')->insert([
            'id' => $media['id'],
            'filename' => $media['hash'],
            'original_name' => $media['original_name'],
            'mime_type' => $media['mime_type'],
            'size' => $media['size'],
            'created_at' => $this->timestamp($media['created_at'] ?? null) ?? now(),
            'updated_at' => now(),
        ]);

        return true;
    }
}
