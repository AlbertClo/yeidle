<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->string('cloud_url')->nullable();
            $table->text('cloud_token')->nullable();
        });
    }

    public function down(): void
    {
        Schema::table('sync_state', function (Blueprint $table) {
            $table->dropColumn(['cloud_url', 'cloud_token']);
        });
    }
};
