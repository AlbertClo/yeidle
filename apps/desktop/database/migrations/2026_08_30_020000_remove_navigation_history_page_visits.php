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
            ->where(function ($query): void {
                $query->where('url', '/navigation-history')
                    ->orWhere('url', 'like', '/navigation-history?%');
            })
            ->orderBy('visited_at')
            ->get(['id', 'parent_id']);

        foreach ($locations as $location) {
            DB::table('navigation_locations')
                ->where('parent_id', $location->id)
                ->update(['parent_id' => $location->parent_id]);

            DB::table('navigation_history_states')
                ->where('current_location_id', $location->id)
                ->update(['current_location_id' => $location->parent_id]);

            DB::table('navigation_locations')
                ->where('id', $location->id)
                ->delete();
        }
    }

    public function down(): void
    {
        // Navigation-history page visits are intentionally not restored.
    }
};
