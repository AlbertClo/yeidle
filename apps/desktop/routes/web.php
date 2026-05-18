<?php

use App\Http\Controllers\PageWebController;
use Illuminate\Support\Facades\Route;

Route::inertia('/', 'Pages/Index')->name('home');

Route::get('pages', [PageWebController::class, 'index'])->name('pages.index');
Route::get('pages/{node}', [PageWebController::class, 'show'])->name('pages.show');

Route::inertia('dashboard', 'Dashboard')->name('dashboard');

require __DIR__.'/settings.php';
