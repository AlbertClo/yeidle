<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Support\CollapsedNodes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class CollapsedNodeController extends Controller
{
    public function __construct(
        private CollapsedNodes $collapsedNodes,
    ) {}

    public function index(): JsonResponse
    {
        return response()->json($this->collapsedNodes->listing());
    }

    public function update(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'node_ids' => ['required', 'array', 'min:1', 'max:1000'],
            'node_ids.*' => ['required', 'string', 'uuid', 'distinct'],
            'collapsed' => ['required', 'boolean'],
        ]);
        $nodes = Node::query()->whereKey($validated['node_ids'])->get();

        abort_unless($nodes->count() === count($validated['node_ids']), 404);

        if ($validated['collapsed']) {
            abort_unless($nodes->count() === 1, 422);
            $this->collapsedNodes->collapse($nodes->sole());
        } else {
            $this->collapsedNodes->expand($nodes->all());
        }

        return response()->json($this->collapsedNodes->listing());
    }
}
