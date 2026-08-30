<?php

use App\Http\Controllers\CloudAccountController;
use App\Http\Controllers\CloudController;
use App\Http\Controllers\CollapsedNodeController;
use App\Http\Controllers\DailyNoteController;
use App\Http\Controllers\KeyBindingController;
use App\Http\Controllers\MediaController;
use App\Http\Controllers\NavigationHistoryController;
use App\Http\Controllers\NodeController;
use App\Http\Controllers\PageController;
use App\Http\Controllers\PinController;
use App\Http\Controllers\PreferenceController;
use App\Http\Controllers\RoamImportController;
use App\Http\Controllers\SearchController;
use App\Http\Controllers\SyncController;
use App\Http\Controllers\WorkspaceController;
use Illuminate\Support\Facades\Route;

Route::get('workspaces', [WorkspaceController::class, 'index']);
Route::post('workspaces', [WorkspaceController::class, 'store']);
Route::patch('workspaces/{workspaceId}', [WorkspaceController::class, 'update']);
Route::delete('workspaces/{workspaceId}', [WorkspaceController::class, 'destroy']);
Route::post('workspaces/{workspaceId}/sync', [WorkspaceController::class, 'sync']);
Route::post('workspaces/{workspaceId}/show-on-disk', [WorkspaceController::class, 'showOnDisk']);
Route::post('workspaces/{workspaceId}/activate', [WorkspaceController::class, 'activate']);

Route::get('account', [CloudAccountController::class, 'show']);
Route::post('account/connect', [CloudAccountController::class, 'connect']);
Route::delete('account/connect', [CloudAccountController::class, 'cancelAuthorization']);
Route::post('account/complete', [CloudAccountController::class, 'completeAuthorization']);
Route::post('account/broadcasting-auth', [CloudAccountController::class, 'authorizeRealtime']);
Route::post('account/refresh', [CloudAccountController::class, 'refresh']);
Route::post('account/sync-active-workspace', [CloudAccountController::class, 'syncActiveWorkspace']);
Route::delete('account', [CloudAccountController::class, 'destroy']);

Route::post('imports/roam/init', [RoamImportController::class, 'initialize']);
Route::post('imports/roam/chunk', [RoamImportController::class, 'uploadChunk']);
Route::post('imports/roam/finish', [RoamImportController::class, 'finish']);
Route::post('imports/roam/stream', [RoamImportController::class, 'stream']);
Route::delete('imports/roam/{uploadId}', [RoamImportController::class, 'cancel']);

Route::post('sync/push', [SyncController::class, 'push']);
Route::get('sync/pull', [SyncController::class, 'pull']);

Route::post('cloud/connect', [CloudController::class, 'connect']);
Route::post('cloud/workspaces', [CloudController::class, 'workspaces']);
Route::get('cloud/status', [CloudController::class, 'status']);
Route::get('cloud/realtime-config', [CloudController::class, 'realtimeConfig']);
Route::post('cloud/broadcasting-auth', [CloudController::class, 'authorizeRealtime']);
Route::post('cloud/realtime-ops', [CloudController::class, 'ingestRealtimeOps']);
Route::post('sync/cloud-exchange', [CloudController::class, 'exchange']);

// Intent-level façade: mints ops server-side (see NodeController)
Route::post('nodes', [NodeController::class, 'store']);
Route::post('daily-notes', [DailyNoteController::class, 'store']);
Route::get('nodes/{node}/reference', [NodeController::class, 'reference']);

Route::get('pages', [PageController::class, 'index']);
Route::get('pins', [PinController::class, 'index']);
Route::put('pins/order', [PinController::class, 'reorder']);
Route::put('nodes/{node}/pin', [PinController::class, 'store']);
Route::delete('nodes/{node}/pin', [PinController::class, 'destroy']);
Route::get('collapsed-nodes', [CollapsedNodeController::class, 'index']);
Route::put('collapsed-nodes', [CollapsedNodeController::class, 'update']);
Route::get('preferences', [PreferenceController::class, 'show']);
Route::put('preferences/theme', [PreferenceController::class, 'updateTheme']);
Route::put('preferences/typography', [PreferenceController::class, 'updateTypography']);
Route::put('preferences/workspace-storage', [PreferenceController::class, 'updateWorkspaceStorage']);
Route::get('key-bindings', [KeyBindingController::class, 'show']);
Route::put('key-bindings', [KeyBindingController::class, 'update']);
Route::get('navigation-history', [NavigationHistoryController::class, 'show']);
Route::delete('navigation-history', [NavigationHistoryController::class, 'clear']);
Route::put('navigation-history/locations/{locationId}', [NavigationHistoryController::class, 'save']);
Route::put('navigation-history/current', [NavigationHistoryController::class, 'setCurrent']);
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
