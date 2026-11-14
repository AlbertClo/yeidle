<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The Loro document relay log. Update bytes are stored as received and
     * never decoded; server_seq is the pull cursor (monotonic within each
     * workspace because pushes are serialized per workspace).
     */
    public function up(): void
    {
        Schema::create('document_updates', function (Blueprint $table) {
            $table->bigIncrements('server_seq');
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->string('document_id', 64);
            $table->string('update_id', 64);
            $table->string('device_id', 100);
            $table->foreignId('user_id')->constrained();
            $table->binary('bytes');
            $table->dateTime('created_at');

            $table->unique(['workspace_id', 'update_id']);
            $table->index(['workspace_id', 'server_seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('document_updates');
    }
};
