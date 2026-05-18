<?php

namespace App\Http\Controllers;

use App\Models\Node;
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
            $query->orderBy('position')
                ->with('children');
        }]);

        $backlinks = $node->incomingLinks()
            ->with('sourceNode')
            ->get();

        return Inertia::render('Pages/Show', [
            'page' => $node,
            'backlinks' => $backlinks,
        ]);
    }
}
