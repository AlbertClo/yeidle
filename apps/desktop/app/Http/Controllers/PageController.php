<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\PageVisit;
use App\Support\Shell;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class PageController extends Controller
{
    public function index(): JsonResponse
    {
        $pages = Node::pages()
            ->orderedByModification()
            ->get();

        return response()->json($pages);
    }

    /**
     * Advisory duplicate-title check for the rename UI. Just advice, not
     * an invariant: sync can always merge in same-titled pages from other
     * devices, so the client warns rather than the log rejecting.
     */
    public function titleExists(Request $request): JsonResponse
    {
        $request->validate([
            'title' => ['required', 'string'],
            'except' => ['nullable', 'string'],
        ]);

        $exists = Node::pages()
            ->when($request->except, fn ($q) => $q->where('id', '!=', $request->except))
            ->whereRaw('LOWER(content) = ?', [strtolower($request->title)])
            ->exists();

        return response()->json(['exists' => $exists]);
    }

    public function show(Node $node): JsonResponse
    {
        abort_if($node->isSystemNode(), 404);

        $node->load('children');
        $this->loadChildrenRecursive($node);

        return response()->json($node);
    }

    private function loadChildrenRecursive(Node $node): void
    {
        foreach ($node->children as $child) {
            $child->load('children');
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
        abort_if($node->isSystemNode(), 404);

        $backlinks = $node->incomingLinks()
            ->with('sourceNode')
            ->get()
            ->filter(fn ($link) => $link->sourceNode !== null)
            ->map(function ($link) {
                $page = $link->sourceNode;
                while ($page->parent_id) {
                    $page = Node::find($page->parent_id);
                    if (! $page) {
                        break;
                    }
                }
                if (! $page) {
                    return null;
                }

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
        Shell::open($request->url);

        return response()->json(null, 200);
    }
}
