<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The operation-log sync (ops applied into a server copy of nodes,
     * links and media) was replaced by the Loro update relay
     * (document_updates). Nothing reads these tables any more.
     */
    public function up(): void
    {
        Schema::dropIfExists('node_links');
        Schema::dropIfExists('media');
        Schema::dropIfExists('nodes');
        Schema::dropIfExists('ops');
    }

    /**
     * Not reversible: the data was a projection of operations that are gone.
     */
    public function down(): void {}
};
