<?php

use App\Http\Controllers\Api\AccountPreferenceController;
use App\Http\Controllers\Api\DeviceAuthorizationController;
use App\Http\Controllers\Api\WorkspaceController;
use App\Http\Controllers\BlobController;
use App\Http\Controllers\SyncController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;

Route::post('/device-authorizations', [DeviceAuthorizationController::class, 'store'])
    ->middleware('throttle:60,1');
Route::post('/device-authorizations/{deviceAuthorization}/broadcasting-auth', [DeviceAuthorizationController::class, 'authorizeRealtime'])
    ->middleware('throttle:120,1');
Route::post('/device-authorizations/{deviceAuthorization}/token', [DeviceAuthorizationController::class, 'token'])
    ->middleware('throttle:60,1');

Route::middleware('auth:sanctum')->group(function () {
    Route::get('/user', function (Request $request) {
        return $request->user();
    });

    Route::get('/workspaces', [WorkspaceController::class, 'index']);
    Route::post('/workspaces', [WorkspaceController::class, 'store']);
    Route::patch('/workspaces/{workspace}', [WorkspaceController::class, 'update']);
    Route::delete('/workspaces/{workspace}', [WorkspaceController::class, 'destroy']);
    Route::get('/user/preferences', [AccountPreferenceController::class, 'show']);
    Route::put('/user/preferences', [AccountPreferenceController::class, 'update']);
    Route::delete('/device', [DeviceAuthorizationController::class, 'destroy']);

    Route::prefix('/workspaces/{workspace}')->group(function () {
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
});
