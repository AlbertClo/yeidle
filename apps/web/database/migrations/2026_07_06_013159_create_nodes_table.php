<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Projection table — only ever written by the op-apply function.
     * Mirrors the desktop schema plus workspace scoping.
     */
    public function up(): void
    {
        Schema::create('nodes', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->uuid('parent_id')->nullable();
            $table->string('position', 50)->default('a0');
            $table->text('content')->default('');
            $table->jsonb('tiptap_content')->nullable();
            $table->boolean('is_checked')->nullable();
            $table->jsonb('field_clocks')->nullable();
            $table->boolean('purged')->default(false);
            $table->softDeletes();
            $table->timestamps();

            $table->index(['workspace_id', 'parent_id']);
        });

        // Separate statement: the self-referential FK must be added after
        // the primary key constraint exists (Postgres orders the inline
        // version before it)
        Schema::table('nodes', function (Blueprint $table) {
            $table->foreign('parent_id')->references('id')->on('nodes')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('nodes');
    }
};
