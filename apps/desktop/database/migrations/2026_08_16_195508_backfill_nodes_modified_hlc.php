<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        DB::table('nodes')
            ->select(['id', 'field_clocks'])
            ->chunkById(500, function ($nodes): void {
                foreach ($nodes as $node) {
                    $clocks = json_decode((string) $node->field_clocks, true);
                    $hlcs = is_array($clocks)
                        ? array_values(array_filter($clocks, is_string(...)))
                        : [];

                    DB::table('nodes')
                        ->where('id', $node->id)
                        ->update(['modified_hlc' => $hlcs === [] ? '' : max($hlcs)]);
                }
            });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        DB::table('nodes')->update(['modified_hlc' => '']);
    }
};
