<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\PageVisit;
use Inertia\Inertia;
use Inertia\Response;

class PageWebController extends Controller
{
    public function index(): Response
    {
        $pages = Node::pages()
            ->orderBy('updated_at', 'desc')
            ->get();

        return Inertia::render('Pages/Index', [
            'pages' => $pages,
        ]);
    }

    public function show(Node $node): Response
    {
        $node->load(['children' => function ($query) {
            $query->orderBy('position');
        }]);

        // Recursively load all nested children
        $this->loadChildrenRecursive($node);

        $backlinks = $node->incomingLinks()
            ->with('sourceNode')
            ->get();

        PageVisit::create([
            'node_id' => $node->id,
            'visited_at' => now(),
        ]);

        return Inertia::render('Pages/Show', [
            'page' => $node,
            'backlinks' => $backlinks,
        ]);
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
}
