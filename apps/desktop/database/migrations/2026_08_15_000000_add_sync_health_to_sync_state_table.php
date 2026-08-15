<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->timestamp('last_sync_attempt_at')->nullable();
            $table->timestamp('last_sync_success_at')->nullable();
            $table->text('last_sync_error')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->dropColumn([
                'last_sync_attempt_at',
                'last_sync_success_at',
                'last_sync_error',
            ]);
        });
    }
};
