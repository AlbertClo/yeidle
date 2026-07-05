<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Services\LinkParser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

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

    /**
     * Apply a set of node changes atomically: upserts in the given order
     * (parents before children), then deletes. All-or-nothing — any failure
     * rolls back the whole batch.
     */
    public function batch(Request $request): JsonResponse
    {
        $data = $request->validate([
            'upserts' => ['array'],
            'upserts.*.id' => ['required', 'string', 'uuid'],
            'upserts.*.parent_id' => ['nullable', 'string', 'uuid'],
            'upserts.*.position' => ['required', 'string'],
            'upserts.*.content' => ['nullable', 'string'],
            'upserts.*.tiptap_content' => ['nullable'],
            'upserts.*.is_checked' => ['nullable', 'boolean'],
            'deletes' => ['array'],
            'deletes.*' => ['required', 'string', 'uuid'],
        ]);

        DB::transaction(function () use ($data) {
            foreach ($data['upserts'] ?? [] as $item) {
                // A parent may be created earlier in this same batch, so
                // check existence here rather than with an exists rule
                if (! empty($item['parent_id'])
                    && ! Node::withTrashed()->whereKey($item['parent_id'])->exists()) {
                    throw ValidationException::withMessages([
                        'parent_id' => "Parent node {$item['parent_id']} does not exist.",
                    ]);
                }

                $attributes = [
                    'parent_id' => $item['parent_id'] ?? null,
                    'position' => $item['position'],
                    'content' => $item['content'] ?? '',
                    'tiptap_content' => $item['tiptap_content'] ?? null,
                    'is_checked' => $item['is_checked'] ?? null,
                ];

                $node = Node::withTrashed()->find($item['id']);

                if ($node) {
                    if ($node->trashed()) {
                        $node->restore();
                    }

                    $node->update($attributes);
                } else {
                    $node = Node::create(['id' => $item['id'], ...$attributes]);
                }

                $this->linkParser->syncLinks($node);
            }

            foreach ($data['deletes'] ?? [] as $id) {
                $node = Node::withTrashed()->find($id);

                if ($node && ! $node->trashed()) {
                    $this->deleteRecursive($node);
                }
            }
        });

        return response()->json(null, 200);
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
