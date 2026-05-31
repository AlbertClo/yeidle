<?php

use App\Http\Controllers\BookmarkController;
use App\Http\Controllers\NodeController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\SearchController;
use Illuminate\Support\Facades\Route;

Route::apiResource('nodes', NodeController::class)->only(['store', 'update', 'destroy']);
Route::put('nodes/{node}/sync', [NodeController::class, 'sync']);

Route::get('pages', [PageController::class, 'index']);
Route::get('pages/{node}', [PageController::class, 'show']);
Route::get('pages/{node}/backlinks', [PageController::class, 'backlinks']);

Route::get('bookmarks', [BookmarkController::class, 'index']);
Route::post('bookmarks', [BookmarkController::class, 'store']);

Route::get('search', SearchController::class);
