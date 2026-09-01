<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('node_links', function (Blueprint $table) {
            $table->index('target_node_id');
        });
    }

    public function down(): void
    {
        Schema::table('node_links', function (Blueprint $table) {
            $table->dropIndex(['target_node_id']);
        });
    }
};
