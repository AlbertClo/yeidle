<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // One Loro document per top-level node (page or system root), plus
        // the media document. The snapshot holds every update up to
        // snapshot_seq; later updates are replayed on top of it.
        Schema::create('documents', function (Blueprint $table) {
            $table->string('id')->primary();
            $table->binary('snapshot')->nullable();
            $table->unsignedBigInteger('snapshot_seq')->default(0);
            $table->timestamp('updated_at')->nullable();
        });

        // Append-only log of Loro updates. The autoincrement id is the local
        // sequence; cloud_seq is set once the cloud has the update (pushed
        // or pulled), so NULL marks the cloud outbox.
        Schema::create('document_updates', function (Blueprint $table) {
            $table->id();
            $table->string('document_id')->index();
            $table->uuid('update_id')->unique();
            $table->string('client_id');
            $table->binary('bytes');
            $table->unsignedBigInteger('cloud_seq')->nullable()->index();
            $table->timestamp('created_at')->nullable();
        });

        Schema::table('nodes', function (Blueprint $table) {
            $table->string('document_id')->nullable()->index();
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropIndex(['document_id']);
            $table->dropColumn('document_id');
        });
        Schema::dropIfExists('document_updates');
        Schema::dropIfExists('documents');
    }
};
