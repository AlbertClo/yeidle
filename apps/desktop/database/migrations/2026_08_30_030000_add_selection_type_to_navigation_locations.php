<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('navigation_locations') && ! Schema::hasColumn('navigation_locations', 'selection_type')) {
            Schema::table('navigation_locations', function (Blueprint $table) {
                $table->string('selection_type')->nullable()->after('cursor_offset');
            });
        }
    }

    public function down(): void
    {
        if (Schema::hasTable('navigation_locations') && Schema::hasColumn('navigation_locations', 'selection_type')) {
            Schema::table('navigation_locations', function (Blueprint $table) {
                $table->dropColumn('selection_type');
            });
        }
    }
};
