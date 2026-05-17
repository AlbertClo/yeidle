<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Services\LinkParser;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class BookmarkController extends Controller
{
    public function __construct(
        private LinkParser $linkParser,
    ) {}

    public function index(): JsonResponse
    {
        $bookmarks = Node::bookmarks()
            ->orderBy('created_at', 'desc')
            ->get();

        return response()->json($bookmarks);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'url' => ['required', 'url', 'unique:nodes,url'],
            'content' => ['required', 'string'],
        ]);

        $node = Node::create($validated);
        $this->linkParser->syncLinks($node);

        return response()->json($node, 201);
    }
}
