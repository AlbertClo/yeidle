<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Op;
use App\Sync\HlcGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SyncEndpointTest extends TestCase
{
    use RefreshDatabase;

    private function makeOp(string $type, array $payload, int $millis, string $client = 'window-1'): array
    {
        return [
            'op_id' => fake()->uuid(),
            'client_id' => $client,
            'hlc' => HlcGenerator::encode($millis, 0, $client),
            'type' => $type,
            'payload' => $payload,
        ];
    }

    public function test_push_appends_to_log_and_applies(): void
    {
        $id = fake()->uuid();
        $op = $this->makeOp('node.set', ['id' => $id, 'fields' => ['content' => 'hello']], 100);

        $response = $this->postJson('/api/sync/push', ['client_id' => 'window-1', 'ops' => [$op]]);

        $response->assertOk();
        $response->assertJsonPath('accepted.0.op_id', $op['op_id']);
        $this->assertSame('hello', Node::find($id)->content);
        $this->assertSame(1, Op::count());
    }

    public function test_push_is_idempotent(): void
    {
        $id = fake()->uuid();
        $op = $this->makeOp('node.set', ['id' => $id, 'fields' => ['content' => 'once']], 100);

        $this->postJson('/api/sync/push', ['client_id' => 'window-1', 'ops' => [$op]])->assertOk();
        $second = $this->postJson('/api/sync/push', ['client_id' => 'window-1', 'ops' => [$op]]);

        $second->assertOk();
        $second->assertJsonPath('accepted.0.op_id', $op['op_id']);
        $this->assertSame(1, Op::count());
        $this->assertSame('once', Node::find($id)->content);
    }

    public function test_invalid_op_rejects_whole_batch(): void
    {
        $id = fake()->uuid();
        $good = $this->makeOp('node.set', ['id' => $id, 'fields' => ['content' => 'x']], 100);
        $bad = $this->makeOp('node.teleport', ['id' => $id, 'fields' => []], 101);

        $this->postJson('/api/sync/push', ['client_id' => 'w', 'ops' => [$good, $bad]])
            ->assertStatus(422);

        $this->assertSame(0, Op::count());
        $this->assertNull(Node::find($id));
    }

    public function test_payload_is_logged_verbatim_including_page_id(): void
    {
        $id = fake()->uuid();
        $pageId = fake()->uuid();
        $op = $this->makeOp('node.set', [
            'v' => 1,
            'id' => $id,
            'page_id' => $pageId,
            'fields' => ['content' => 'x'],
        ], 100);

        $this->postJson('/api/sync/push', ['client_id' => 'w', 'ops' => [$op]])->assertOk();

        $pulled = $this->getJson('/api/sync/pull?since=0')->json('ops.0.payload');
        $this->assertSame($pageId, $pulled['page_id']);
        $this->assertSame(1, $pulled['v']);
    }

    public function test_pull_returns_ops_after_cursor(): void
    {
        $a = $this->makeOp('node.set', ['id' => fake()->uuid(), 'fields' => ['content' => 'a']], 100);
        $b = $this->makeOp('node.set', ['id' => fake()->uuid(), 'fields' => ['content' => 'b']], 101);

        $this->postJson('/api/sync/push', ['client_id' => 'w', 'ops' => [$a, $b]])->assertOk();

        $all = $this->getJson('/api/sync/pull?since=0');
        $all->assertOk();
        $this->assertCount(2, $all->json('ops'));
        $latest = $all->json('latest_seq');

        $none = $this->getJson("/api/sync/pull?since={$latest}");
        $this->assertCount(0, $none->json('ops'));
        $this->assertSame($latest, $none->json('latest_seq'));
    }

    public function test_mention_in_pushed_op_rebuilds_links(): void
    {
        $source = fake()->uuid();
        $target = fake()->uuid();

        $ops = [
            $this->makeOp('node.set', ['id' => $target, 'fields' => ['content' => 'Target Page']], 100),
            $this->makeOp('node.set', [
                'id' => $source,
                'fields' => [
                    'content' => 'links to [[Target Page]]',
                    'tiptap_content' => [
                        'type' => 'paragraph',
                        'content' => [
                            ['type' => 'mention', 'attrs' => ['id' => $target, 'label' => 'Target Page']],
                        ],
                    ],
                ],
            ], 101),
        ];

        $this->postJson('/api/sync/push', ['client_id' => 'w', 'ops' => $ops])->assertOk();

        $link = NodeLink::where('source_node_id', $source)->first();
        $this->assertNotNull($link);
        $this->assertSame($target, $link->target_node_id);
        $this->assertSame('Target Page', $link->display_name);
    }

    public function test_purge_via_push_scrubs_node_and_links(): void
    {
        $source = fake()->uuid();
        $target = fake()->uuid();

        $this->postJson('/api/sync/push', ['client_id' => 'w', 'ops' => [
            $this->makeOp('node.set', ['id' => $target, 'fields' => ['content' => 'T']], 100),
            $this->makeOp('node.set', [
                'id' => $source,
                'fields' => [
                    'content' => 'secret',
                    'tiptap_content' => [
                        'type' => 'paragraph',
                        'content' => [['type' => 'mention', 'attrs' => ['id' => $target, 'label' => 'T']]],
                    ],
                ],
            ], 101),
            $this->makeOp('node.purge', ['id' => $source], 200),
        ]])->assertOk();

        $node = Node::withTrashed()->find($source);
        $this->assertTrue($node->purged);
        $this->assertSame('', $node->content);
        $this->assertSame(0, NodeLink::where('source_node_id', $source)->count());
    }
}
