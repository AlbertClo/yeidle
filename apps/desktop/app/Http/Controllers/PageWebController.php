<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\Op;
use App\Models\PageVisit;
use Inertia\Inertia;
use Inertia\Response;

class PageWebController extends Controller
{
    public function index(): Response
    {
        $pages = Node::pages()
            ->orderedByModification()
            ->get();

        return Inertia::render('Pages/Index', [
            'pages' => $pages,
        ]);
    }

    public function show(Node $node): Response
    {
        // Pull cursor for the live-sync poll. Read BEFORE loading nodes: an
        // op landing between the two reads is then re-pulled and re-applied
        // (idempotent) rather than silently missed.
        $syncCursor = (int) (Op::max('id') ?? 0);

        $node->load('children');

        // Recursively load all nested children
        $this->loadChildrenRecursive($node);

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

        PageVisit::create([
            'node_id' => $node->id,
            'visited_at' => now(),
        ]);

        return Inertia::render('Pages/Show', [
            'page' => $node,
            'backlinks' => $backlinks,
            'syncCursor' => $syncCursor,
        ]);
    }

    private function loadChildrenRecursive(Node $node): void
    {
        foreach ($node->children as $child) {
            $child->load('children');
            $this->loadChildrenRecursive($child);
        }
    }
}
