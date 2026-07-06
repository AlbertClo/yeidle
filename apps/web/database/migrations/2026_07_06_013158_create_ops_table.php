<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The append-only operation log (sync design §5, §8). server_seq is a
     * global sequence — monotonic within every workspace, which is all the
     * cursor contract requires. user_id is stamped server-side at accept
     * time and never trusted from the client.
     */
    public function up(): void
    {
        Schema::create('ops', function (Blueprint $table) {
            $table->bigIncrements('server_seq');
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->uuid('op_id')->unique();
            $table->string('client_id');
            $table->foreignId('user_id')->constrained();
            $table->string('hlc', 64);
            $table->string('type', 32);
            $table->jsonb('payload');
            $table->dateTime('created_at');

            $table->index(['workspace_id', 'server_seq']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ops');
    }
};
