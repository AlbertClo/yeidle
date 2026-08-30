<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::table('nodes')
            ->where('page_type', 'daily_note')
            ->whereNotNull('daily_note_date')
            ->select(['id', 'daily_note_date'])
            ->orderBy('id')
            ->each(function (object $node): void {
                DB::table('nodes')
                    ->where('id', $node->id)
                    ->update([
                        'created_at' => $node->daily_note_date.' 00:00:00',
                    ]);
            });
    }

    public function down(): void
    {
        // The original creation timestamps cannot be reconstructed.
    }
};
