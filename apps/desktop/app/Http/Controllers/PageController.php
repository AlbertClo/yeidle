<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\PageVisit;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

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

    public function recent(): JsonResponse
    {
        $recentIds = PageVisit::select('node_id')
            ->selectRaw('MAX(visited_at) as last_visit')
            ->groupBy('node_id')
            ->orderByDesc('last_visit')
            ->limit(10)
            ->pluck('node_id');

        $pages = Node::whereIn('id', $recentIds)
            ->get()
            ->sortBy(fn ($node) => $recentIds->search($node->id))
            ->values();

        return response()->json($pages);
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

    public function visit(Request $request): JsonResponse
    {
        $request->validate(['node_id' => ['required', 'exists:nodes,id']]);

        PageVisit::create([
            'node_id' => $request->node_id,
            'visited_at' => now(),
        ]);

        return response()->json(null, 201);
    }

    public function openExternal(Request $request): JsonResponse
    {
        $request->validate(['url' => ['required', 'url']]);
        \App\Support\Shell::open($request->url);

        return response()->json(null, 200);
    }
}
