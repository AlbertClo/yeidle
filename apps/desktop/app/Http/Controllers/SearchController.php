<?php

namespace App\Http\Controllers;

use App\Models\Node;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SearchController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $request->validate([
            'q' => ['required', 'string', 'min:1'],
        ]);

        // Deletion marks only the subtree root (sync design §5), so filter
        // out matches living inside deleted subtrees
        $results = Node::where('content', 'like', '%'.$request->q.'%')
            ->orderBy('updated_at', 'desc')
            ->limit(120)
            ->get()
            ->filter(fn (Node $node) => $node->isReachable())
            ->take(60)
            ->values();

        return response()->json($results);
    }
}
