<?php

use App\Http\Controllers\DeviceAuthorizationController;
use App\Http\Controllers\DashboardController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'Welcome')->name('home');

Route::middleware(['auth', 'verified'])->group(function () {
    Route::get('dashboard', [DashboardController::class, 'index'])->name('dashboard');
    Route::post('workspaces', [DashboardController::class, 'storeWorkspace'])->name('workspaces.store');
    Route::delete('devices/{device}', [DashboardController::class, 'destroyDevice'])->name('devices.destroy');
});

Route::middleware('auth')->group(function () {
    Route::get('device/authorize/{deviceAuthorization}', [DeviceAuthorizationController::class, 'show'])
        ->name('device-authorizations.show');
    Route::post('device/authorize/{deviceAuthorization}', [DeviceAuthorizationController::class, 'approve'])
        ->name('device-authorizations.approve');
});

require __DIR__.'/settings.php';
