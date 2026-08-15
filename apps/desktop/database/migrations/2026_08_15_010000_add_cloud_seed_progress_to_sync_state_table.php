<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->uuid('cloud_workspace_id')->nullable();
            $table->boolean('cloud_seed_pending')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->dropColumn([
                'cloud_workspace_id',
                'cloud_seed_pending',
            ]);
        });
    }
};
