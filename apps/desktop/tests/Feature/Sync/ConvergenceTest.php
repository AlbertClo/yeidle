<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use App\Models\NodeLink;
use App\Sync\HlcGenerator;
use App\Sync\OpApplier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * The property the whole sync design rests on (design doc §12): any set of
 * ops, applied in any delivery order, any number of times, converges to an
 * identical projection. Simulates N devices exchanging ops in arbitrary
 * orders — a failure here means replicas would diverge in production.
 */
class ConvergenceTest extends TestCase
{
    use RefreshDatabase;

    private function applyAll(array $ops): array
    {
        $applier = new OpApplier;

        foreach ($ops as $op) {
            $applier->apply($op);
        }

        return $this->projectionDump();
    }

    private function projectionDump(): array
    {
        $links = NodeLink::orderBy('source_node_id')
            ->orderBy('target_node_id')
            ->get()
            ->map(fn ($l) => [
                'source' => $l->source_node_id,
                'target' => $l->target_node_id,
                'display_name' => $l->display_name,
            ])
            ->all();

        $nodes = Node::withTrashed()
            ->orderBy('id')
            ->get()
            ->map(fn (Node $n) => [
                'id' => $n->id,
                'parent_id' => $n->parent_id,
                'position' => $n->position,
                'content' => $n->content,
                'tiptap_content' => $n->tiptap_content,
                'is_checked' => $n->is_checked,
                'deleted_at' => $n->deleted_at?->format('Y-m-d H:i:s'),
                'purged' => $n->purged,
                'field_clocks' => $n->field_clocks,
                'modified_hlc' => $n->modified_hlc,
                'reachable' => $n->isReachable(),
            ])
            ->all();

        return ['nodes' => $nodes, 'links' => $links];
    }

    private function resetProjection(): void
    {
        DB::statement('DELETE FROM node_links');
        DB::statement('DELETE FROM nodes');
    }

    /**
     * @param  callable(): array  $opsFactory
     */
    private function assertConverges(array $ops, int $permutations = 6, ?int $seed = null): void
    {
        $reference = $this->applyAll($ops);
        $this->assertNotEmpty($reference);

        mt_srand($seed ?? 1);

        for ($i = 0; $i < $permutations; $i++) {
            $shuffled = $ops;
            shuffle($shuffled);

            $this->resetProjection();
            $dump = $this->applyAll($shuffled);

            $this->assertSame($reference, $dump, "diverged on permutation {$i}");
        }

        // Idempotency: applying everything twice changes nothing
        $this->resetProjection();
        $twice = $this->applyAll([...$ops, ...array_reverse($ops)]);
        $this->assertSame($reference, $twice, 'diverged on double application');
    }

    private function op(string $type, array $payload, int $millis, string $client): array
    {
        return [
            'op_id' => sprintf('%032x', $millis * 131 + crc32($client.$type.json_encode($payload))),
            'client_id' => $client,
            'hlc' => HlcGenerator::encode($millis, 0, $client),
            'type' => $type,
            'payload' => $payload,
        ];
    }

    public function test_move_edit_delete_scenario_converges(): void
    {
        $ids = ['p1', 'p2', 'c1', 'c2', 'g1'];
        [$p1, $p2, $c1, $c2, $g1] = array_map(fn ($k) => fake()->uuid(), $ids);

        $ops = [
            $this->op('node.set', ['id' => $p1, 'fields' => ['content' => 'Page 1']], 10, 'a'),
            $this->op('node.set', ['id' => $p2, 'fields' => ['content' => 'Page 2']], 11, 'a'),
            $this->op('node.set', ['id' => $c1, 'fields' => ['parent_id' => $p1, 'content' => 'one', 'position' => 'a0']], 12, 'a'),
            $this->op('node.set', ['id' => $c2, 'fields' => ['parent_id' => $p1, 'content' => 'two', 'position' => 'a1']], 13, 'a'),
            $this->op('node.set', ['id' => $g1, 'fields' => ['parent_id' => $c1, 'content' => 'deep', 'position' => 'a0']], 14, 'a'),
            // Device b: edits and moves
            $this->op('node.set', ['id' => $c1, 'fields' => ['content' => 'one edited']], 100, 'b'),
            $this->op('node.set', ['id' => $g1, 'fields' => ['parent_id' => $p2]], 101, 'b'),
            // Device c: concurrent deletes and a checkbox
            $this->op('node.delete', ['id' => $c1], 102, 'c'),
            $this->op('node.set', ['id' => $c2, 'fields' => ['is_checked' => true]], 103, 'c'),
            // Device b again: revive c1 by editing it later
            $this->op('node.set', ['id' => $c1, 'fields' => ['position' => 'a2']], 200, 'b'),
        ];

        $this->assertConverges($ops);
    }

    public function test_purge_scenario_converges(): void
    {
        $a = fake()->uuid();
        $b = fake()->uuid();

        $ops = [
            $this->op('node.set', ['id' => $a, 'fields' => ['content' => 'secret']], 10, 'a'),
            $this->op('node.set', ['id' => $b, 'fields' => ['parent_id' => $a, 'content' => 'child']], 11, 'a'),
            $this->op('node.purge', ['id' => $a], 100, 'a'),
            // Much newer edits from a device that never saw the purge
            $this->op('node.set', ['id' => $a, 'fields' => ['content' => 'resurrection']], 900, 'b'),
            $this->op('node.delete', ['id' => $a], 901, 'b'),
            $this->op('node.set', ['id' => $b, 'fields' => ['content' => 'still here']], 902, 'b'),
        ];

        $this->assertConverges($ops);
    }

    public function test_random_op_soup_converges(): void
    {
        foreach ([42, 1337, 2026] as $seed) {
            mt_srand($seed);

            $ids = [];
            for ($i = 0; $i < 8; $i++) {
                $ids[] = sprintf('00000000-0000-7000-8000-%012d', $i);
            }

            $clients = ['aa', 'bb', 'cc'];
            $fields = ['content', 'position', 'is_checked', 'parent_id'];
            $ops = [];

            for ($i = 0; $i < 80; $i++) {
                $client = $clients[mt_rand(0, 2)];
                $id = $ids[mt_rand(0, count($ids) - 1)];
                $millis = mt_rand(1, 5000);
                $roll = mt_rand(1, 100);

                if ($roll <= 75) {
                    $set = [];
                    foreach ($fields as $f) {
                        if (mt_rand(0, 1) === 0) {
                            $set[$f] = match ($f) {
                                'content' => 'v'.mt_rand(1, 999),
                                'position' => 'a'.mt_rand(0, 9),
                                'is_checked' => (bool) mt_rand(0, 1),
                                'parent_id' => mt_rand(0, 3) === 0 ? null : $ids[mt_rand(0, count($ids) - 1)],
                            };
                        }
                    }
                    if (mt_rand(0, 2) === 0) {
                        // Mention another node so the node_links projection
                        // is exercised under permutation too
                        $target = $ids[mt_rand(0, count($ids) - 1)];
                        $set['tiptap_content'] = [
                            'type' => 'paragraph',
                            'content' => [
                                ['type' => 'mention', 'attrs' => ['id' => $target, 'label' => 'ref']],
                            ],
                        ];
                    }
                    $ops[] = $this->op('node.set', ['id' => $id, 'fields' => $set], $millis, $client);
                } elseif ($roll <= 95) {
                    $ops[] = $this->op('node.delete', ['id' => $id], $millis, $client);
                } else {
                    $ops[] = $this->op('node.purge', ['id' => $id], $millis, $client);
                }
            }

            // Distinct HLCs per (millis, client) pair aren't guaranteed by
            // the generator above; dedupe to keep LWW ties out of scope —
            // real generators never emit duplicates for one client
            $seen = [];
            $ops = array_values(array_filter($ops, function ($op) use (&$seen) {
                $key = $op['hlc'];
                if (isset($seen[$key])) {
                    return false;
                }

                return $seen[$key] = true;
            }));

            $this->resetProjection();
            $this->assertConverges($ops, permutations: 8, seed: $seed);
        }
    }
}
