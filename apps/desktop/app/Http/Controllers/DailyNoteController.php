<?php

namespace App\Http\Controllers;

use App\DailyNotes\DailyNoteService;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

final class DailyNoteController extends Controller
{
    public function __construct(
        private readonly DailyNoteService $dailyNotes,
        private readonly WorkspaceIndex $workspaces,
    ) {}

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'date' => ['required', 'date_format:Y-m-d'],
        ]);

        $page = $this->dailyNotes->open(
            $this->workspaces->active()['id'],
            $validated['date'],
        );

        return response()->json([
            'id' => $page->id,
            'date' => $page->daily_note_date,
        ]);
    }
}
