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
        Schema::create('nodes', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('parent_id')->nullable()->constrained('nodes')->cascadeOnDelete();
            $table->integer('position')->default(0);
            $table->text('content')->default('');
            $table->string('url')->nullable()->unique();
            $table->boolean('is_checked')->nullable();
            $table->timestamps();
            $table->softDeletes();

            $table->index('parent_id');
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::dropIfExists('nodes');
    }
};
