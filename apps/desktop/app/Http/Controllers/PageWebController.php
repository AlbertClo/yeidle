<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\Op;
use App\Models\PageVisit;
use App\Support\PinNodes;
use App\Support\PreferenceNodes;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class PageWebController extends Controller
{
    public function __construct(
        private PinNodes $pins,
        private PreferenceNodes $preferences,
    ) {}

    public function index(Request $request): Response
    {
        $pages = Node::pages()
            ->orderedByModification()
            ->get();
        $preferences = $this->preferences->listing();
        $workspaceCloudStatus = app()->resolved(WorkspaceIndex::class)
            ? app(WorkspaceIndex::class)->active()['cloud_status']
            : 'local';

        return Inertia::render('Pages/Index', [
            'pages' => $pages,
            'themeSetupRequired' => $preferences['theme'] === null,
            'storageSetupRequired' => $preferences['workspace_storage'] === null
                && $workspaceCloudStatus === 'local',
            'workspaceCloudStatus' => $workspaceCloudStatus,
            'missingPage' => $request->session()->get('missing_page', false),
            'databaseRecovered' => app()->resolved(WorkspaceIndex::class)
                && app(WorkspaceIndex::class)->recoveredMissingDatabase(),
        ]);
    }

    public function show(string $node): Response|RedirectResponse
    {
        $page = Node::find($node);

        if ($page === null) {
            return to_route('pages.index')->with('missing_page', true);
        }

        abort_if($page->isSystemNode(), 404);

        // Pull cursor for the live-sync poll. Read BEFORE loading nodes: an
        // op landing between the two reads is then re-pulled and re-applied
        // (idempotent) rather than silently missed.
        $syncCursor = (int) (Op::max('id') ?? 0);

        $page->load('children');

        // Recursively load all nested children
        $this->loadChildrenRecursive($page);

        $backlinks = $page->incomingLinks()
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
            'node_id' => $page->id,
            'visited_at' => now(),
        ]);

        return Inertia::render('Pages/Show', [
            'page' => $page,
            'pinned' => $this->pins->isPinned($page),
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
