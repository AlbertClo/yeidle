<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

/**
 * Intent-level façade over the op log (sync design §14): accepts simple
 * "make this node exist" requests and mints the ops server-side, so callers
 * (PageSearch, the wikilink popup, the future extension) never touch the op
 * protocol. Projections are only ever written by the op-apply function.
 */
class NodeController extends Controller
{
    public function __construct(
        private SyncService $sync,
    ) {}

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => ['nullable', 'string', 'uuid'],
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['nullable', 'string'],
            'content' => ['nullable', 'string'],
            'tiptap_content' => ['nullable'],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $content = $validated['content'] ?? '';
        $parentId = $validated['parent_id'] ?? null;

        // For top-level pages, return the existing page with the same title
        // instead of creating a duplicate (create-page flows rely on this)
        if ($parentId === null && $content !== '') {
            $existing = Node::pages()
                ->whereRaw('LOWER(content) = ?', [strtolower($content)])
                ->first();

            if ($existing) {
                return response()->json($existing->load('children'), 200);
            }
        }

        $id = $validated['id'] ?? (string) Str::uuid7();
        $wasKnown = Node::withTrashed()->whereKey($id)->exists();

        // Servers are op producers with their own clock identity (§4);
        // a fresh client_id per request keeps HLCs collision-free
        $clock = new HlcGenerator('srv-'.Str::uuid7());

        $this->sync->push([[
            'op_id' => (string) Str::uuid7(),
            'client_id' => $clock->clientId,
            'hlc' => $clock->now(),
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $this->rootPageId($id, $parentId),
                'fields' => [
                    'parent_id' => $parentId,
                    'position' => $validated['position'] ?? 'a0',
                    'content' => $content,
                    'tiptap_content' => $validated['tiptap_content'] ?? null,
                    'is_checked' => $validated['is_checked'] ?? null,
                ],
            ],
        ]]);

        return response()->json(
            Node::findOrFail($id)->load('children'),
            $wasKnown ? 200 : 201,
        );
    }

    public function reference(Node $node): JsonResponse
    {
        abort_unless($node->isReachable() && ! $node->isPinSystemNode(), 404);

        $page = $node;
        while ($page->parent_id !== null) {
            $parent = Node::find($page->parent_id);

            if (! $parent) {
                break;
            }

            $page = $parent;
        }

        $node->load('children');
        $this->loadChildrenRecursive($node, []);

        return response()->json([
            'id' => $node->id,
            'content' => $node->content,
            'tiptap_content' => $node->tiptap_content,
            'page_id' => $page->id,
            'children' => $node->children,
        ]);
    }

    /** The top-level page an op belongs to: itself for pages, else the root
     * of the parent chain. */
    private function rootPageId(string $id, ?string $parentId): string
    {
        if ($parentId === null) {
            return $id;
        }

        $node = Node::withTrashed()->find($parentId);

        while ($node && $node->parent_id !== null) {
            $node = Node::withTrashed()->find($node->parent_id);
        }

        return $node?->id ?? $id;
    }

    /** @param array<string, true> $visited */
    private function loadChildrenRecursive(Node $node, array $visited): void
    {
        if (isset($visited[$node->id])) {
            $node->setRelation('children', collect());

            return;
        }

        $visited[$node->id] = true;

        foreach ($node->children as $child) {
            $child->load('children');
            $this->loadChildrenRecursive($child, $visited);
        }
    }
}
