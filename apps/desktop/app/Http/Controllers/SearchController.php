<?php

namespace App\Http\Controllers;

use App\Models\Node;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SearchController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $request->validate([
            'q' => ['required', 'string', 'min:2'],
        ]);

        $results = Node::where('content', 'like', '%'.$request->q.'%')
            ->orderBy('updated_at', 'desc')
            ->limit(50)
            ->get();

        return response()->json($results);
    }
}
