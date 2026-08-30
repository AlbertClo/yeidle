<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('navigation_locations')) {
            return;
        }

        $locations = DB::table('navigation_locations')
            ->where('url', 'like', '%_windowId=%')
            ->get(['id', 'url']);

        foreach ($locations as $location) {
            $parts = parse_url($location->url);
            $path = ($parts['path'] ?? '/') === '/' ? '/pages' : $parts['path'];
            parse_str($parts['query'] ?? '', $query);
            unset($query['_windowId']);
            $queryString = http_build_query($query);

            DB::table('navigation_locations')
                ->where('id', $location->id)
                ->update([
                    'url' => $path.($queryString === '' ? '' : '?'.$queryString),
                ]);
        }
    }

    public function down(): void
    {
        // NativePHP transport parameters are intentionally not restored.
    }
};
