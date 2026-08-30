<?php

namespace App\Http\Controllers;

use App\Models\Node;
use App\Models\Op;
use App\Models\PageVisit;
use App\Services\NodeTreeLoader;
use App\Support\PinNodes;
use App\Support\PreferenceNodes;
use App\Support\SystemNodes;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;

class PageWebController extends Controller
{
    public function __construct(
        private PinNodes $pins,
        private PreferenceNodes $preferences,
        private NodeTreeLoader $trees,
    ) {}

    public function index(Request $request): Response
    {
        $pages = DB::table('nodes')
            ->select([
                'id',
                'content',
                'page_type',
                'daily_note_date',
                'created_at',
            ])
            ->whereNull('parent_id')
            ->whereNull('deleted_at')
            ->whereNotIn('id', SystemNodes::ROOT_IDS)
            ->orderByDesc('modified_hlc')
            ->orderByDesc('id')
            ->get();
        $preferences = $this->preferences->listing();
        $workspaceCloudStatus = app()->resolved(WorkspaceIndex::class)
            ? app(WorkspaceIndex::class)->active()['cloud_status']
            : 'local';
        $themeSetupRequired = $preferences['theme'] === null;
        $storageSetupRequired = $preferences['workspace_storage'] === null
            && $workspaceCloudStatus === 'local';

        return Inertia::render('Pages/Index', [
            'pages' => $pages,
            'themeSetupRequired' => $themeSetupRequired,
            'storageSetupRequired' => $storageSetupRequired,
            'workspaceCloudStatus' => $workspaceCloudStatus,
            'openDailyNote' => $request->routeIs('home'),
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

        $pageTree = $this->trees->load($page->id);

        PageVisit::create([
            'node_id' => $page->id,
            'visited_at' => now(),
        ]);

        return Inertia::render('Pages/Show', [
            'page' => $pageTree,
            'pinned' => $this->pins->isPinned($page),
            // Show.vue refreshes backlinks after mounting and after edits.
            'backlinks' => [],
            'syncCursor' => $syncCursor,
        ]);
    }
}
