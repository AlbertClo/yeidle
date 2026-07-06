<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Derived projection — rebuilt from tiptap mentions by the op-apply
     * function, never synced.
     */
    public function up(): void
    {
        Schema::create('node_links', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->foreignUuid('source_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->foreignUuid('target_node_id')->constrained('nodes')->cascadeOnDelete();
            $table->string('display_name')->nullable();
            $table->timestamps();

            $table->unique(['source_node_id', 'target_node_id']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('node_links');
    }
};
