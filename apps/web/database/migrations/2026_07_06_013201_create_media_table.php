<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Projection table for media metadata. Blobs live in object storage
     * keyed blobs/{hash} (sync design §9); filename holds the content hash.
     */
    public function up(): void
    {
        Schema::create('media', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->string('filename', 64);
            $table->string('original_name');
            $table->string('mime_type');
            $table->unsignedBigInteger('size');
            $table->timestamps();

            $table->index(['workspace_id', 'filename']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('media');
    }
};
