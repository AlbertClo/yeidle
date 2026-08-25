<?php

use App\Http\Controllers\PageWebController;
use Illuminate\Support\Facades\Route;

Route::get('/', [PageWebController::class, 'index'])->name('home');

Route::get('pages', [PageWebController::class, 'index'])->name('pages.index');
Route::get('pages/{node}', [PageWebController::class, 'show'])->name('pages.show');

require __DIR__.'/settings.php';
