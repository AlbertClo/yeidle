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
            ->get()
            ->filter(fn ($link) => $link->sourceNode !== null)
            ->map(function ($link) {
                $page = $link->sourceNode;
                while ($page->parent_id) {
                    $page = Node::find($page->parent_id);
                    if (!$page) break;
                }
                if (!$page) return null;
                return [
                    'id' => $link->id,
                    'page_id' => $page->id,
                    'page_title' => $page->content ?: '[untitled]',
                ];
            })
            ->filter()
            ->unique('page_id')
            ->values();

        return response()->json($backlinks);
    }
}
