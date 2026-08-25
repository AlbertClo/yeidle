<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Support\PinNodes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class PinController extends Controller
{
    public function __construct(
        private PinNodes $pins,
    ) {}

    public function index(): JsonResponse
    {
        $listing = $this->pins->listing();

        return response()->json([
            'root_id' => $listing['root_id'],
            'items' => $listing['items'],
        ]);
    }

    public function store(Node $node): JsonResponse
    {
        $this->pins->add($node);

        return response()->json([
            'pinned' => true,
            'item' => $node,
        ]);
    }

    public function destroy(Node $node): JsonResponse
    {
        $this->pins->remove($node->id);

        return response()->json(['pinned' => false]);
    }

    public function reorder(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'node_ids' => ['present', 'array', 'max:1000'],
            'node_ids.*' => ['required', 'string', 'uuid', 'distinct'],
        ]);
        $nodeIds = $validated['node_ids'];
        if (! $this->pins->reorder($nodeIds)) {
            throw ValidationException::withMessages([
                'node_ids' => 'The pinned list changed. Reload it and try again.',
            ]);
        }

        return response()->json(['reordered' => true]);
    }
}
