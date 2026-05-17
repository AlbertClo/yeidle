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
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['integer'],
            'content' => ['string'],
            'url' => ['nullable', 'url', 'unique:nodes,url'],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $node = Node::create($validated);
        $this->linkParser->syncLinks($node);

        return response()->json($node->load('children'), 201);
    }

    public function update(Request $request, Node $node): JsonResponse
    {
        $validated = $request->validate([
            'parent_id' => ['nullable', 'exists:nodes,id'],
            'position' => ['integer'],
            'content' => ['string'],
            'url' => ['nullable', 'url', 'unique:nodes,url,'.$node->id],
            'is_checked' => ['nullable', 'boolean'],
        ]);

        $node->update($validated);
        $this->linkParser->syncLinks($node);

        return response()->json($node);
    }

    public function destroy(Node $node): JsonResponse
    {
        $node->delete();

        return response()->json(null, 204);
    }
}
