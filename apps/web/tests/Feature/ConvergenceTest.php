<?php

use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Workspace;
use App\Sync\HlcGenerator;
use App\Sync\OpApplier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;

/*
 * The property the whole sync design rests on (design doc §12): any set of
 * ops, applied in any delivery order, any number of times, converges to an
 * identical projection. Ported from the desktop harness — the two appliers
 * are deliberately duplicated (§8) and this keeps them semantically pinned.
 */

uses(RefreshDatabase::class);

function convergenceOp(string $type, array $payload, int $millis, string $client): array
{
    return [
        'op_id' => sprintf('%032x', $millis * 131 + crc32($client.$type.json_encode($payload))),
        'client_id' => $client,
        'hlc' => HlcGenerator::encode($millis, 0, $client),
        'type' => $type,
        'payload' => $payload,
    ];
}

function applyAll(string $workspaceId, array $ops): array
{
    $applier = new OpApplier($workspaceId);

    foreach ($ops as $op) {
        $applier->apply($op);
    }

    $links = NodeLink::orderBy('source_node_id')->orderBy('target_node_id')
        ->get()
        ->map(fn ($l) => [$l->source_node_id, $l->target_node_id, $l->display_name])
        ->all();

    $nodes = Node::withTrashed()->orderBy('id')->get()
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
            'reachable' => $n->isReachable(),
        ])
        ->all();

    return ['nodes' => $nodes, 'links' => $links];
}

function assertConverges(string $workspaceId, array $ops, int $permutations = 6): void
{
    $reset = function () {
        DB::statement('DELETE FROM node_links');
        DB::statement('DELETE FROM nodes');
    };

    $reference = applyAll($workspaceId, $ops);
    expect($reference['nodes'])->not->toBeEmpty();

    mt_srand(1);

    for ($i = 0; $i < $permutations; $i++) {
        $shuffled = $ops;
        shuffle($shuffled);

        $reset();
        expect(applyAll($workspaceId, $shuffled))->toBe($reference, "diverged on permutation {$i}");
    }

    $reset();
    expect(applyAll($workspaceId, [...$ops, ...array_reverse($ops)]))
        ->toBe($reference, 'diverged on double application');
}

test('random op soup converges on postgres', function () {
    $workspace = Workspace::factory()->create();

    foreach ([42, 1337] as $seed) {
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
                    $target = $ids[mt_rand(0, count($ids) - 1)];
                    $set['tiptap_content'] = [
                        'type' => 'paragraph',
                        'content' => [
                            ['type' => 'mention', 'attrs' => ['id' => $target, 'label' => 'ref']],
                        ],
                    ];
                }
                $ops[] = convergenceOp('node.set', ['id' => $id, 'fields' => $set], $millis, $client);
            } elseif ($roll <= 95) {
                $ops[] = convergenceOp('node.delete', ['id' => $id], $millis, $client);
            } else {
                $ops[] = convergenceOp('node.purge', ['id' => $id], $millis, $client);
            }
        }

        $seen = [];
        $ops = array_values(array_filter($ops, function ($op) use (&$seen) {
            if (isset($seen[$op['hlc']])) {
                return false;
            }

            return $seen[$op['hlc']] = true;
        }));

        DB::statement('DELETE FROM node_links');
        DB::statement('DELETE FROM nodes');
        assertConverges($workspace->id, $ops, permutations: 8);
    }
});

test('delete revive and purge scenarios converge', function () {
    $workspace = Workspace::factory()->create();

    $a = fake()->uuid();
    $b = fake()->uuid();
    $c = fake()->uuid();

    assertConverges($workspace->id, [
        convergenceOp('node.set', ['id' => $a, 'fields' => ['content' => 'page']], 10, 'x'),
        convergenceOp('node.set', ['id' => $b, 'fields' => ['parent_id' => $a, 'content' => 'child']], 11, 'x'),
        convergenceOp('node.set', ['id' => $c, 'fields' => ['parent_id' => $b, 'content' => 'grandchild']], 12, 'x'),
        convergenceOp('node.delete', ['id' => $b], 100, 'y'),
        convergenceOp('node.set', ['id' => $b, 'fields' => ['content' => 'revived']], 200, 'z'),
        convergenceOp('node.purge', ['id' => $c], 300, 'x'),
        convergenceOp('node.set', ['id' => $c, 'fields' => ['content' => 'resurrection attempt']], 999, 'y'),
    ]);
});
