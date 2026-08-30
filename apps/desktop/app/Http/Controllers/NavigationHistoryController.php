<?php

namespace App\Http\Controllers;

use App\Navigation\NavigationHistoryStore;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Str;

final class NavigationHistoryController extends Controller
{
    public function __construct(
        private readonly NavigationHistoryStore $history,
    ) {}

    public function show(): JsonResponse
    {
        return response()->json($this->history->get());
    }

    public function save(Request $request, string $locationId): JsonResponse
    {
        $validated = $request->validate([
            'parent_id' => ['nullable', 'uuid'],
            'url' => ['required', 'string', 'max:2048', 'starts_with:/'],
            'page_id' => ['nullable', 'uuid'],
            'block_id' => ['nullable', 'uuid'],
            'cursor_offset' => ['nullable', 'integer', 'min:0'],
            'selection_type' => ['nullable', 'string', 'in:text,node'],
            'scroll_top' => ['required', 'integer', 'min:0'],
            'visited_at' => ['required', 'date'],
            'last_visited_at' => ['required', 'date'],
            'make_current' => ['sometimes', 'boolean'],
        ]);

        abort_unless(Str::isUuid($locationId), 404);

        $validated['url'] = $this->canonicalUrl($validated['url']);

        if (parse_url($validated['url'], PHP_URL_PATH) === '/navigation-history') {
            return response()->json(null, 204);
        }

        return response()->json($this->history->save(
            $locationId,
            $validated,
            (bool) ($validated['make_current'] ?? false),
        ));
    }

    private function canonicalUrl(string $url): string
    {
        $parts = parse_url($url);
        $path = ($parts['path'] ?? '/') === '/' ? '/pages' : $parts['path'];
        parse_str($parts['query'] ?? '', $query);
        unset($query['_windowId']);
        $queryString = http_build_query($query);

        return $path.($queryString === '' ? '' : '?'.$queryString);
    }

    public function setCurrent(Request $request): JsonResponse
    {
        $validated = $request->validate(['id' => ['required', 'uuid']]);

        $this->history->setCurrent($validated['id']);

        return response()->json(['current_id' => $validated['id']]);
    }

    public function clear(): JsonResponse
    {
        $this->history->clear();

        return response()->json(null, 204);
    }
}
