<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\Node;
use App\Models\NodeLink;
use App\Services\LinkParser;
use Carbon\Carbon;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * Applies ops to the projection tables, scoped to one workspace. This is
 * the ONLY code allowed to write projections (sync design §12), and its
 * defining property is convergence: any set of ops, applied in any order,
 * any number of times, yields the same projection.
 *
 * Deliberately duplicated from the desktop applier (sync design §8) — the
 * merge semantics are pinned to it by the shared convergence harness and
 * HLC test vectors. Change the two in lockstep.
 */
class OpApplier
{
    private const NODE_FIELDS = ['parent_id', 'position', 'content', 'tiptap_content', 'is_checked'];

    public function __construct(
        private string $workspaceId,
        private LinkParser $linkParser = new LinkParser,
    ) {}

    public function apply(array $op): void
    {
        match ($op['type']) {
            'node.set' => $this->applyNodeSet($op),
            'node.delete' => $this->applyNodeDelete($op),
            'node.purge' => $this->applyNodePurge($op),
            'media.create' => $this->applyMediaCreate($op),
            default => throw new \InvalidArgumentException("Unknown op type: {$op['type']}"),
        };
    }

    private function applyNodeSet(array $op): void
    {
        $node = $this->ensureNode($op['payload']['id']);

        if ($node === null || $node->purged) {
            return;
        }

        $clocks = $node->field_clocks ?? [];
        $hlc = $op['hlc'];
        $tiptapChanged = false;

        foreach ($op['payload']['fields'] as $field => $value) {
            if (! in_array($field, self::NODE_FIELDS, true)) {
                continue;
            }

            if ($hlc > ($clocks[$field] ?? HlcGenerator::EPOCH)) {
                if ($field === 'parent_id' && $value !== null) {
                    if ($this->ensureNode($value) === null) {
                        continue;
                    }
                }

                if ($field === 'content') {
                    $value = $value ?? '';
                }

                if ($field === 'position') {
                    $value = $value ?? 'a0';
                }

                $node->{$field} = $value;
                $clocks[$field] = $hlc;

                if ($field === 'tiptap_content') {
                    $tiptapChanged = true;
                }
            }
        }

        if ($hlc > ($clocks['deleted'] ?? HlcGenerator::EPOCH)) {
            $node->deleted_at = null;
            $clocks['deleted'] = $hlc;
        }

        ksort($clocks);
        $node->field_clocks = $clocks;
        $node->modified_hlc = $clocks === [] ? HlcGenerator::EPOCH : max($clocks);
        $node->save();

        if ($tiptapChanged) {
            $this->rebuildLinks($node);
        }
    }

    private function applyNodeDelete(array $op): void
    {
        $node = $this->ensureNode($op['payload']['id']);

        if ($node === null || $node->purged) {
            return;
        }

        $clocks = $node->field_clocks ?? [];

        if ($op['hlc'] > ($clocks['deleted'] ?? HlcGenerator::EPOCH)) {
            $node->deleted_at = Carbon::createFromTimestampMs(HlcGenerator::millisOf($op['hlc']));
            $clocks['deleted'] = $op['hlc'];
            ksort($clocks);
            $node->field_clocks = $clocks;
            $node->modified_hlc = max($clocks);
            $node->save();
        }
    }

    private function applyNodePurge(array $op): void
    {
        $node = $this->ensureNode($op['payload']['id']);

        if ($node === null) {
            return;
        }

        $purgedAt = Carbon::createFromTimestampMs(HlcGenerator::millisOf($op['hlc']));

        if ($node->purged) {
            if ($node->deleted_at && $purgedAt->lt($node->deleted_at)) {
                $node->deleted_at = $purgedAt;
            }

            if ($node->modified_hlc === '' || $op['hlc'] < $node->modified_hlc) {
                $node->modified_hlc = $op['hlc'];
            }

            $node->save();

            return;
        }

        $node->purged = true;
        $node->parent_id = null;
        $node->position = 'a0';
        $node->content = '';
        $node->tiptap_content = null;
        $node->is_checked = null;
        $node->field_clocks = null;
        $node->deleted_at = $purgedAt;
        $node->modified_hlc = $op['hlc'];
        $node->save();

        $node->outgoingLinks()->delete();
    }

    private function applyMediaCreate(array $op): void
    {
        $payload = $op['payload'];

        foreach (['id', 'hash', 'original_name', 'mime_type', 'size'] as $key) {
            if (! isset($payload[$key])) {
                return;
            }
        }

        if (! is_string($payload['hash'])
            || preg_match('/^[0-9a-f]{64}$/D', $payload['hash']) !== 1
            || ! is_string($payload['original_name'])
            || ! is_string($payload['mime_type'])
            || filter_var($payload['size'], FILTER_VALIDATE_INT) === false
            || (int) $payload['size'] < 1) {
            return;
        }

        // An id claimed by any workspace (this one: idempotent replay;
        // another: cross-tenant reference) means drop. Checked up front —
        // catching a constraint violation would poison the enclosing
        // Postgres transaction.
        if (Media::whereKey($payload['id'])->exists()) {
            return;
        }

        try {
            // Nested transaction = SAVEPOINT: a TOCTOU constraint violation
            // rolls back only this insert, not the whole push
            DB::transaction(fn () => Media::create([
                'id' => $payload['id'],
                'workspace_id' => $this->workspaceId,
                'filename' => $payload['hash'],
                'original_name' => $payload['original_name'],
                'mime_type' => $payload['mime_type'],
                'size' => (int) $payload['size'],
            ]));
        } catch (QueryException) {
            // Lost the race — drop deterministically
        }
    }

    private function rebuildLinks(Node $node): void
    {
        $node->outgoingLinks()->delete();

        if (! $node->tiptap_content) {
            return;
        }

        $links = [];

        foreach ($this->linkParser->extractMentions($node->tiptap_content) as $mention) {
            $links[$mention['id']] = $mention['label'] ?? null;
        }

        ksort($links);

        foreach ($links as $targetId => $label) {
            if ($this->ensureNode($targetId) === null) {
                continue;
            }

            NodeLink::create([
                'workspace_id' => $this->workspaceId,
                'source_node_id' => $node->id,
                'target_node_id' => $targetId,
                'display_name' => $label,
            ]);
        }
    }

    /**
     * Find or shell-create a node within this workspace. Returns null when
     * the id is claimed by another workspace (cross-tenant reference in a
     * malicious or corrupt op) so callers drop the op deterministically.
     */
    private function ensureNode(string $id): ?Node
    {
        $node = Node::withTrashed()
            ->whereKey($id)
            ->where('workspace_id', $this->workspaceId)
            ->first();

        if ($node) {
            return $node;
        }

        // Claimed by another workspace: drop. Checked up front — catching
        // the constraint violation would poison the enclosing Postgres
        // transaction.
        if (Node::withTrashed()->whereKey($id)->exists()) {
            return null;
        }

        try {
            // Nested transaction = SAVEPOINT (see applyMediaCreate)
            return DB::transaction(function () use ($id) {
                $node = new Node;
                $node->id = $id;
                $node->workspace_id = $this->workspaceId;
                $node->content = '';
                $node->position = 'a0';
                $node->save();

                return $node;
            });
        } catch (QueryException) {
            return null;
        }
    }
}
