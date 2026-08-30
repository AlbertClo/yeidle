<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->string('page_type')->nullable();
            $table->date('daily_note_date')->nullable();
            $table->index(['workspace_id', 'page_type', 'daily_note_date']);
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropIndex(['workspace_id', 'page_type', 'daily_note_date']);
            $table->dropColumn(['page_type', 'daily_note_date']);
        });
    }
};
