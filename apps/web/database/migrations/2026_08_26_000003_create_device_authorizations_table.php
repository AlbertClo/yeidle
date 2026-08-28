<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('device_authorizations', function (Blueprint $table) {
            $table->uuid('id')->primary();
            $table->string('secret_hash', 64);
            $table->string('device_name', 100);
            $table->foreignId('user_id')->nullable()->constrained()->cascadeOnDelete();
            $table->text('issued_token')->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamp('consumed_at')->nullable();
            $table->timestamp('expires_at')->index();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('device_authorizations');
    }
};
