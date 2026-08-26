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
        Schema::table('nodes', function (Blueprint $table) {
            $table->text('modified_hlc')->default('');
            $table->index(
                ['workspace_id', 'parent_id', 'deleted_at', 'modified_hlc', 'id'],
                'nodes_page_order_index',
            );
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropIndex('nodes_page_order_index');
            $table->dropColumn('modified_hlc');
        });
    }
};
