<?php

namespace App\Http\Controllers;

use App\Search\NodeSearch;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SearchController extends Controller
{
    public function __construct(
        private readonly NodeSearch $search,
    ) {}

    public function __invoke(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'q' => ['required', 'string', 'min:1', 'max:200'],
        ]);

        return response()->json($this->search->search($validated['q']));
    }
}
