<?php

use App\Http\Controllers\BlobController;
use App\Http\Controllers\SyncController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', function (Request $request) {
        return $request->user();
    });

    Route::post('/sync/push', [SyncController::class, 'push']);
    Route::get('/sync/pull', [SyncController::class, 'pull']);
    Route::get('/sync/bootstrap', [SyncController::class, 'bootstrap']);
    Route::get('/sync/status', [SyncController::class, 'status']);

    Route::match(['HEAD'], '/blobs/{hash}', [BlobController::class, 'exists'])
        ->where('hash', '[0-9a-f]{64}');
    Route::post('/blobs/{hash}/upload-url', [BlobController::class, 'uploadUrl'])
        ->where('hash', '[0-9a-f]{64}');
    Route::get('/blobs/{hash}/download-url', [BlobController::class, 'downloadUrl'])
        ->where('hash', '[0-9a-f]{64}');
});
