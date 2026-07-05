<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('ops', function (Blueprint $table) {
            // Autoincrement id doubles as local_seq: local arrival order
            $table->increments('id');
            $table->uuid('op_id')->unique();
            $table->unsignedBigInteger('server_seq')->nullable()->index();
            $table->uuid('client_id');
            $table->string('hlc', 64)->index();
            $table->string('type', 32);
            $table->json('payload');
            $table->dateTime('created_at');
        });

        Schema::create('sync_state', function (Blueprint $table) {
            $table->increments('id');
            $table->uuid('client_id');
            $table->unsignedBigInteger('last_server_seq')->default(0);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('ops');
        Schema::dropIfExists('sync_state');
    }
};
