<?php

use App\Http\Controllers\CloudController;
use App\Http\Controllers\MediaController;
use App\Http\Controllers\NodeController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\SearchController;
use App\Http\Controllers\SyncController;
use Illuminate\Support\Facades\Route;

Route::post('sync/push', [SyncController::class, 'push']);
Route::get('sync/pull', [SyncController::class, 'pull']);

Route::post('cloud/connect', [CloudController::class, 'connect']);
Route::get('cloud/status', [CloudController::class, 'status']);
Route::post('sync/cloud-exchange', [CloudController::class, 'exchange']);

// Intent-level façade: mints ops server-side (see NodeController)
Route::post('nodes', [NodeController::class, 'store']);

Route::get('pages', [PageController::class, 'index']);
// Before pages/{node} so "title-exists" isn't captured as a node id
Route::get('pages/title-exists', [PageController::class, 'titleExists']);
Route::get('pages/{node}', [PageController::class, 'show']);
Route::get('pages/{node}/backlinks', [PageController::class, 'backlinks']);

Route::get('search', SearchController::class);

Route::post('media/init', [MediaController::class, 'initUpload']);
Route::post('media/chunk', [MediaController::class, 'uploadChunk']);
Route::post('media/complete', [MediaController::class, 'completeUpload']);
Route::get('media/{media}', [MediaController::class, 'show']);
Route::post('media/{media}/open', [MediaController::class, 'open']);
Route::post('media/{media}/open-folder', [MediaController::class, 'openFolder']);

Route::get('recent-pages', [PageController::class, 'recent']);
Route::post('page-visits', [PageController::class, 'visit']);
Route::post('open-external', [PageController::class, 'openExternal']);
