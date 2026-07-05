<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    private const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

    public function up(): void
    {
        // Convert existing integer positions to fractional-indexing format
        $parents = DB::table('nodes')->select('parent_id')->distinct()->pluck('parent_id');

        foreach ($parents as $parentId) {
            $nodes = DB::table('nodes')
                ->where('parent_id', $parentId)
                ->orderBy('position')
                ->get(['id', 'position']);

            foreach ($nodes as $i => $node) {
                DB::table('nodes')
                    ->where('id', $node->id)
                    ->update(['position' => 'a'.self::DIGITS[$i % 62]]);
            }
        }

        // Also handle top-level pages (parent_id IS NULL)
        $topLevel = DB::table('nodes')
            ->whereNull('parent_id')
            ->orderBy('position')
            ->get(['id', 'position']);

        foreach ($topLevel as $i => $node) {
            DB::table('nodes')
                ->where('id', $node->id)
                ->update(['position' => 'a'.self::DIGITS[$i % 62]]);
        }

        Schema::table('nodes', function (Blueprint $table) {
            $table->string('position', 50)->default('a0')->change();
        });
    }

    public function down(): void
    {
        // Convert back to integers
        $parents = DB::table('nodes')->select('parent_id')->distinct()->pluck('parent_id');

        foreach ($parents as $parentId) {
            $nodes = DB::table('nodes')
                ->where('parent_id', $parentId)
                ->orderBy('position')
                ->get(['id']);

            foreach ($nodes as $i => $node) {
                DB::table('nodes')
                    ->where('id', $node->id)
                    ->update(['position' => $i]);
            }
        }

        $topLevel = DB::table('nodes')
            ->whereNull('parent_id')
            ->orderBy('position')
            ->get(['id']);

        foreach ($topLevel as $i => $node) {
            DB::table('nodes')
                ->where('id', $node->id)
                ->update(['position' => $i]);
        }

        Schema::table('nodes', function (Blueprint $table) {
            $table->integer('position')->default(0)->change();
        });
    }
};
