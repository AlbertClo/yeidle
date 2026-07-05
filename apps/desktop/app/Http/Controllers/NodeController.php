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
            'id' => ['nullable', 'string', 'uuid'],
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['required', 'string'],
            'content' => ['nullable', 'string'],
            'tiptap_content' => ['nullable'],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $validated['content'] = $validated['content'] ?? '';

        // Upsert by id so creates are idempotent (safe to retry) and a
        // client-side undo after delete restores the trashed row
        if (! empty($validated['id'])) {
            $existing = Node::withTrashed()->find($validated['id']);

            if ($existing) {
                if ($existing->trashed()) {
                    $existing->restore();
                }

                $existing->update($validated);
                $this->linkParser->syncLinks($existing);

                return response()->json($existing->load('children'), 200);
            }
        }

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
            'parent_id' => ['exists:nodes,id'],
            'position' => ['string'],
            'content' => ['nullable', 'string'],
            'tiptap_content' => ['nullable'],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        if (array_key_exists('content', $validated)) {
            $validated['content'] = $validated['content'] ?? '';
        }

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

    public function destroy(string $node): JsonResponse
    {
        // Idempotent: deleting a missing or already-trashed node succeeds
        $found = Node::withTrashed()->find($node);

        if ($found && ! $found->trashed()) {
            $this->deleteRecursive($found);
        }

        return response()->json(null, 204);
    }

    private function deleteRecursive(Node $node): void
    {
        foreach ($node->children as $child) {
            $this->deleteRecursive($child);
        }
        $node->delete();
    }
}
