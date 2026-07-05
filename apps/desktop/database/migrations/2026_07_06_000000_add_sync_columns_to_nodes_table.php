<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            // Per-field HLC of the last write (design doc §5). NULL means
            // every field is at the epoch clock: existing data is the
            // genesis snapshot and any real op wins over it.
            $table->json('field_clocks')->nullable();

            // Terminal hard-delete marker (design doc §5): content scrubbed,
            // id-only tombstone retained, all later ops for this id dropped.
            $table->boolean('purged')->default(false);
        });
    }

    public function down(): void
    {
        Schema::table('nodes', function (Blueprint $table) {
            $table->dropColumn(['field_clocks', 'purged']);
        });
    }
};
