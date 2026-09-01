<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\PageVisit;
use App\Services\BacklinkLoader;
use App\Services\NodeTreeLoader;
use App\Support\Shell;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class PageController extends Controller
{
    public function __construct(
        private NodeTreeLoader $trees,
        private BacklinkLoader $backlinks,
    ) {}

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

        return response()->json($this->trees->load($node->id));
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

        return response()->json($this->backlinks->load($node->id));
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
