<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::create('node_links', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('source_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->foreignUuid('target_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->string('display_name')->nullable();
            $table->timestamp('created_at')->nullable();
            $table->softDeletes();

            $table->unique(['source_node_id', 'target_node_id']);
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('node_links');
    }
};
