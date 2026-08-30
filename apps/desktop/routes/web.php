<?php

use App\Http\Controllers\NavigationHistoryWebController;
use App\Http\Controllers\PageWebController;
use Illuminate\Support\Facades\Route;

Route::get('/', [PageWebController::class, 'index'])->name('home');

Route::get('pages', [PageWebController::class, 'index'])->name('pages.index');
Route::get('pages/{node}', [PageWebController::class, 'show'])->name('pages.show');
Route::get('navigation-history', NavigationHistoryWebController::class)
    ->name('navigation-history.index');

require __DIR__.'/settings.php';
