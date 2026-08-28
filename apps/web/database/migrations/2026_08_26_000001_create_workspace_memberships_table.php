<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('workspace_memberships', function (Blueprint $table) {
            $table->foreignUuid('workspace_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('role')->default('member');
            $table->timestamps();

            $table->primary(['workspace_id', 'user_id']);
            $table->index('user_id');
        });

        $now = now();

        DB::table('workspaces')
            ->select(['id', 'user_id'])
            ->orderBy('id')
            ->each(function (object $workspace) use ($now): void {
                DB::table('workspace_memberships')->insertOrIgnore([
                    'workspace_id' => $workspace->id,
                    'user_id' => $workspace->user_id,
                    'role' => 'owner',
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            });
    }

    public function down(): void
    {
        Schema::dropIfExists('workspace_memberships');
    }
};
