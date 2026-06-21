<?php

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
