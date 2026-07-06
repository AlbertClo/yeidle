<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\Node;
use App\Models\NodeLink;
use App\Services\LinkParser;
use Carbon\Carbon;

/**
 * Applies ops to the projection tables. This is the ONLY code allowed to
 * write projections (design doc §12), and its defining property is
 * convergence: any set of ops, applied in any order, any number of times,
 * yields the same projection. Enforced by tests/Feature/Sync/ConvergenceTest.
 *
 * Merge rules (design doc §4–§5):
 * - Field-level last-writer-wins: a field is written only if the op's HLC is
 *   strictly greater than the HLC that last wrote it (strict > also makes
 *   re-application a no-op).
 * - Liveness: every node.set asserts the node is alive by also writing the
 *   `deleted` clock, so an edit with a newer HLC revives a deleted node.
 * - Deletion is per-node; subtree deletion is derived at read time from the
 *   merged parent chain (Node::isReachable), never materialized — cascading
 *   at apply time would depend on delivery order.
 * - Purge is terminal and exempt from HLC comparison: content is scrubbed
 *   and every subsequent op referencing the id is dropped.
 */
class OpApplier
{
    private const NODE_FIELDS = ['parent_id', 'position', 'content', 'tiptap_content', 'is_checked'];

    public function __construct(
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

        if ($node->purged) {
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
                    // The parent may not have been created yet under
                    // arbitrary delivery order; a shell satisfies the FK and
                    // is filled in when the parent's own ops arrive
                    $this->ensureNode($value);
                }

                // Canonical coercion for NOT NULL columns: a null in an op
                // must resolve identically on every replica, and a poisoned
                // op must never wedge the log with constraint failures
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

        // Liveness assertion: an edit revives a deleted node. Written
        // unconditionally (not only when currently deleted) so the outcome
        // is independent of whether the edit or the delete arrives first.
        if ($hlc > ($clocks['deleted'] ?? HlcGenerator::EPOCH)) {
            $node->deleted_at = null;
            $clocks['deleted'] = $hlc;
        }

        // Canonical key order so replicas are byte-identical regardless of
        // which op touched a field first
        ksort($clocks);
        $node->field_clocks = $clocks;
        $node->save();

        if ($tiptapChanged) {
            $this->rebuildLinks($node);
        }
    }

    /**
     * node_links is a derived projection (design doc §12): rebuilt from the
     * node's merged tiptap_content whenever it changes, from UUID-based
     * mentions only. Targets that haven't been created yet (arbitrary
     * delivery order) get shell rows so the link row can exist — determinism
     * over prettiness. The legacy title-based [[wikilink]] fallback is
     * NOT run here: resolving titles against local state would mint
     * different page ids on different replicas.
     */
    private function rebuildLinks(Node $node): void
    {
        $node->outgoingLinks()->forceDelete();

        if (! $node->tiptap_content) {
            return;
        }

        $links = [];
        foreach ($this->linkParser->extractMentions($node->tiptap_content) as $mention) {
            $links[$mention['id']] = $mention['label'] ?? null;
        }

        ksort($links);

        foreach ($links as $targetId => $label) {
            $this->ensureNode($targetId);
            NodeLink::create([
                'source_node_id' => $node->id,
                'target_node_id' => $targetId,
                'display_name' => $label,
            ]);
        }
    }

    private function applyNodeDelete(array $op): void
    {
        $node = $this->ensureNode($op['payload']['id']);

        if ($node->purged) {
            return;
        }

        $clocks = $node->field_clocks ?? [];

        if ($op['hlc'] > ($clocks['deleted'] ?? HlcGenerator::EPOCH)) {
            // Derived deterministically from the HLC, not from wall time,
            // so replicas agree byte-for-byte
            $node->deleted_at = Carbon::createFromTimestampMs(HlcGenerator::millisOf($op['hlc']));
            $clocks['deleted'] = $op['hlc'];
            ksort($clocks);
            $node->field_clocks = $clocks;
            $node->save();
        }
    }

    private function applyNodePurge(array $op): void
    {
        $node = $this->ensureNode($op['payload']['id']);
        $purgedAt = Carbon::createFromTimestampMs(HlcGenerator::millisOf($op['hlc']));

        if ($node->purged) {
            // Concurrent purges from different devices: converge on the
            // earliest timestamp so replicas agree regardless of order
            if ($node->deleted_at && $purgedAt->lt($node->deleted_at)) {
                $node->deleted_at = $purgedAt;
                $node->save();
            }

            return;
        }

        // Scrub to a fully canonical terminal state — leaving any mutable
        // field (parent_id, position) as-is would preserve whatever ops
        // happened to apply before the purge arrived, diverging replicas
        $node->purged = true;
        $node->parent_id = null;
        $node->position = 'a0';
        $node->content = '';
        $node->tiptap_content = null;
        $node->is_checked = null;
        $node->field_clocks = null;
        $node->deleted_at = $purgedAt;
        $node->save();

        // Scrubbed content has no mentions; drop the outgoing projection
        $node->outgoingLinks()->forceDelete();
    }

    /**
     * Media metadata is immutable and its ids are unique per upload, so
     * create-if-absent is convergent. The blob itself travels out-of-band,
     * keyed by the content hash (sync design §9).
     */
    private function applyMediaCreate(array $op): void
    {
        $payload = $op['payload'];

        // A malformed op must never wedge the log — drop it deterministically
        foreach (['id', 'hash', 'original_name', 'mime_type', 'size'] as $key) {
            if (! isset($payload[$key])) {
                return;
            }
        }

        if (Media::whereKey($payload['id'])->exists()) {
            return;
        }

        $media = new Media;
        $media->id = $payload['id'];
        $media->filename = $payload['hash'];
        $media->original_name = $payload['original_name'];
        $media->mime_type = $payload['mime_type'];
        $media->size = (int) $payload['size'];
        $media->save();
    }

    private function ensureNode(string $id): Node
    {
        $node = Node::withTrashed()->find($id);

        if ($node) {
            return $node;
        }

        $node = new Node;
        $node->id = $id;
        $node->content = '';
        $node->position = 'a0';
        $node->save();

        return $node;
    }
}
