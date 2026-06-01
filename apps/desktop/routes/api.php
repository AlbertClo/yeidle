<?php

use App\Http\Controllers\BookmarkController;
use App\Http\Controllers\MediaController;
use App\Http\Controllers\NodeController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\SearchController;
use Illuminate\Support\Facades\Route;

Route::apiResource('nodes', NodeController::class)->only(['store', 'update', 'destroy']);
Route::put('nodes/{node}/sync', [NodeController::class, 'sync']);
Route::put('nodes/{node}/sync-content', [NodeController::class, 'syncContent']);

Route::get('pages', [PageController::class, 'index']);
Route::get('pages/{node}', [PageController::class, 'show']);
Route::get('pages/{node}/backlinks', [PageController::class, 'backlinks']);

Route::get('bookmarks', [BookmarkController::class, 'index']);
Route::post('bookmarks', [BookmarkController::class, 'store']);

Route::get('search', SearchController::class);

Route::post('media/init', [MediaController::class, 'initUpload']);
Route::post('media/chunk', [MediaController::class, 'uploadChunk']);
Route::post('media/complete', [MediaController::class, 'completeUpload']);
Route::get('media/{media}', [MediaController::class, 'show']);
Route::post('media/{media}/open', [MediaController::class, 'open']);
Route::post('media/{media}/open-folder', [MediaController::class, 'openFolder']);

Route::get('recent-pages', function () {
    $recentIds = \App\Models\PageVisit::select('node_id')
        ->selectRaw('MAX(visited_at) as last_visit')
        ->groupBy('node_id')
        ->orderByDesc('last_visit')
        ->limit(10)
        ->pluck('node_id');

    return \App\Models\Node::whereIn('id', $recentIds)
        ->get()
        ->sortBy(fn ($node) => $recentIds->search($node->id))
        ->values();
});

Route::post('open-external', function (\Illuminate\Http\Request $request) {
    $request->validate(['url' => ['required', 'url']]);
    \Native\Desktop\Facades\Shell::openExternal($request->url);
    return response()->json(null, 200);
});

Route::post('page-visits', function (\Illuminate\Http\Request $request) {
    $request->validate(['node_id' => ['required', 'exists:nodes,id']]);

    \App\Models\PageVisit::create([
        'node_id' => $request->node_id,
        'visited_at' => now(),
    ]);

    return response()->json(null, 201);
});
