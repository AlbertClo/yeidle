<?php

namespace App\Http\Controllers;

use App\Models\Node;
use Illuminate\Http\JsonResponse;

class PageController extends Controller
{
    public function index(): JsonResponse
    {
        $pages = Node::pages()
            ->orderBy('updated_at', 'desc')
            ->get();

        return response()->json($pages);
    }

    public function show(Node $node): JsonResponse
    {
        $node->load(['children' => function ($query) {
            $query->orderBy('position');
        }]);
        $this->loadChildrenRecursive($node);

        return response()->json($node);
    }

    private function loadChildrenRecursive(Node $node): void
    {
        foreach ($node->children as $child) {
            $child->load(['children' => function ($query) {
                $query->orderBy('position');
            }]);
            $this->loadChildrenRecursive($child);
        }
    }

    public function backlinks(Node $node): JsonResponse
    {
        $backlinks = $node->incomingLinks()
            ->with('sourceNode')
            ->get();

        return response()->json($backlinks);
    }
}
