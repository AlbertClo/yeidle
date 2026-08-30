<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasTable('navigation_locations')) {
            Schema::create('navigation_locations', function (Blueprint $table) {
                $table->uuid('id')->primary();
                $table->string('profile_key');
                $table->uuid('parent_id')->nullable();
                $table->string('url', 2048);
                $table->uuid('page_id')->nullable();
                $table->uuid('block_id')->nullable();
                $table->unsignedInteger('cursor_offset')->nullable();
                $table->string('selection_type')->nullable();
                $table->unsignedInteger('scroll_top')->default(0);
                $table->timestamp('visited_at');
                $table->timestamp('last_visited_at');
                $table->timestamps();

                $table->index(['profile_key', 'parent_id']);
                $table->index(['profile_key', 'last_visited_at']);
            });
        }

        if (! Schema::hasTable('navigation_history_states')) {
            Schema::create('navigation_history_states', function (Blueprint $table) {
                $table->string('profile_key')->primary();
                $table->uuid('current_location_id')->nullable();
                $table->timestamps();
            });
        }

        Schema::dropIfExists('navigation_histories');
    }

    public function down(): void
    {
        // The preceding migration owns the tree tables on clean installs.
    }
};
