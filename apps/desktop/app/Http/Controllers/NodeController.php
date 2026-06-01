<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Services\LinkParser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class NodeController extends Controller
{
    public function __construct(
        private LinkParser $linkParser,
    ) {}

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => ['nullable', 'string', 'uuid', 'unique:nodes,id'],
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['integer'],
            'content' => ['nullable', 'string'],
            'url' => ['nullable', 'url', 'unique:nodes,url'],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $validated['content'] = $validated['content'] ?? '';

        // For top-level pages (no parent), find existing page with same title
        if (empty($validated['parent_id']) && $validated['content'] !== '') {
            $existing = Node::pages()
                ->whereRaw('LOWER(content) = ?', [strtolower($validated['content'])])
                ->first();

            if ($existing) {
                return response()->json($existing->load('children'), 200);
            }
        }

        $node = Node::create($validated);
        $this->linkParser->syncLinks($node);

        return response()->json($node->load('children'), 201);
    }

    public function update(Request $request, Node $node): JsonResponse
    {
        $validated = $request->validate([
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['integer'],
            'content' => ['nullable', 'string'],
            'url' => ['nullable', 'url', 'unique:nodes,url,'.$node->id],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $validated['content'] = $validated['content'] ?? '';

        // Check for duplicate page title when renaming a top-level page
        if ($node->isPage() && isset($validated['content']) && $validated['content'] !== '') {
            $existing = Node::pages()
                ->where('id', '!=', $node->id)
                ->whereRaw('LOWER(content) = ?', [strtolower($validated['content'])])
                ->first();

            if ($existing) {
                return response()->json([
                    'message' => 'A page with this name already exists.',
                ], 409);
            }
        }

        $node->update($validated);
        $this->linkParser->syncLinks($node);

        return response()->json($node);
    }

    public function destroy(Node $node): JsonResponse
    {
        $this->deleteRecursive($node);

        return response()->json(null, 204);
    }

    private function deleteRecursive(Node $node): void
    {
        foreach ($node->children as $child) {
            $this->deleteRecursive($child);
        }
        $node->delete();
    }

    public function sync(Request $request, Node $node): JsonResponse
    {
        $data = $request->validate([
            'content' => ['nullable', 'string'],
            'children' => ['array'],
        ]);

        $node->update(['content' => $data['content'] ?? '']);
        $this->linkParser->syncLinks($node);

        // Get all existing descendant IDs
        $existingIds = $this->getDescendantIds($node);

        // Sync children recursively
        $incomingIds = $this->syncChildren($node, $data['children'] ?? []);

        // Delete nodes that no longer exist
        $toDelete = array_diff($existingIds, $incomingIds);
        if ($toDelete) {
            Node::whereIn('id', $toDelete)->delete();
        }

        return response()->json($node->load('children'));
    }

    public function syncContent(Request $request, Node $node): JsonResponse
    {
        $data = $request->validate([
            'nodes' => ['required', 'array'],
            'nodes.*.id' => ['required', 'string'],
            'nodes.*.tiptap_content' => ['nullable'],
        ]);

        foreach ($data['nodes'] as $item) {
            $child = Node::find($item['id']);
            if ($child) {
                $child->update(['tiptap_content' => $item['tiptap_content']]);
                $this->linkParser->syncLinks($child);
            }
        }

        return response()->json(null, 200);
    }

    private function syncChildren(Node $parent, array $children): array
    {
        $ids = [];
        foreach ($children as $i => $childData) {
            $ids[] = $childData['id'];

            $child = Node::withTrashed()->find($childData['id']);
            if ($child) {
                if ($child->trashed()) {
                    $child->restore();
                }
                $updateData = [
                    'parent_id' => $parent->id,
                    'position' => $i,
                    'content' => $childData['content'] ?? '',
                    'url' => $childData['url'] ?? null,
                    'is_checked' => $childData['is_checked'] ?? null,
                ];
                // Only update tiptap_content when explicitly provided
                if (array_key_exists('tiptap_content', $childData)) {
                    $updateData['tiptap_content'] = $childData['tiptap_content'];
                }
                $child->update($updateData);
            } else {
                $child = Node::create([
                    'id' => $childData['id'],
                    'parent_id' => $parent->id,
                    'position' => $i,
                    'content' => $childData['content'] ?? '',
                    'tiptap_content' => $childData['tiptap_content'] ?? null,
                    'url' => $childData['url'] ?? null,
                    'is_checked' => $childData['is_checked'] ?? null,
                ]);
            }

            $this->linkParser->syncLinks($child);

            $childIds = $this->syncChildren($child, $childData['children'] ?? []);
            $ids = array_merge($ids, $childIds);
        }
        return $ids;
    }

    private function getDescendantIds(Node $node): array
    {
        $ids = [];
        foreach ($node->children as $child) {
            $ids[] = $child->id;
            $ids = array_merge($ids, $this->getDescendantIds($child));
        }
        return $ids;
    }
}
