<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use App\Sync\HlcGenerator;
use App\Sync\OpApplier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class OpApplierTest extends TestCase
{
    use RefreshDatabase;

    private OpApplier $applier;

    protected function setUp(): void
    {
        parent::setUp();
        $this->applier = new OpApplier;
    }

    private function op(string $type, array $payload, int $millis, string $client = 'c1'): array
    {
        return [
            'op_id' => fake()->uuid(),
            'client_id' => $client,
            'hlc' => HlcGenerator::encode($millis, 0, $client),
            'type' => $type,
            'payload' => $payload,
        ];
    }

    private function set(string $id, array $fields, int $millis, string $client = 'c1'): array
    {
        return $this->op('node.set', ['id' => $id, 'fields' => $fields], $millis, $client);
    }

    public function test_creates_and_updates_nodes(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'hello', 'position' => 'a1'], 100));
        $this->applier->apply($this->set($id, ['content' => 'world'], 200));

        $node = Node::find($id);
        $this->assertSame('world', $node->content);
        $this->assertSame('a1', $node->position);
    }

    public function test_older_write_loses_per_field(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'newer'], 200));
        $this->applier->apply($this->set($id, ['content' => 'older', 'position' => 'a5'], 100));

        $node = Node::find($id);
        // content keeps the newer write; position was untouched at 200, so
        // the older op's position write still lands
        $this->assertSame('newer', $node->content);
        $this->assertSame('a5', $node->position);
    }

    public function test_concurrent_move_and_edit_both_survive(): void
    {
        $page = fake()->uuid();
        $other = fake()->uuid();
        $child = fake()->uuid();

        $this->applier->apply($this->set($page, ['content' => 'Page'], 10));
        $this->applier->apply($this->set($other, ['content' => 'Other'], 11));
        $this->applier->apply($this->set($child, ['parent_id' => $page, 'content' => 'original'], 12));

        // Device A moves the child; device B edits its text
        $this->applier->apply($this->set($child, ['parent_id' => $other, 'position' => 'a2'], 100, 'device-a'));
        $this->applier->apply($this->set($child, ['content' => 'edited'], 101, 'device-b'));

        $node = Node::find($child);
        $this->assertSame($other, $node->parent_id);
        $this->assertSame('edited', $node->content);
    }

    public function test_edit_with_newer_hlc_revives_deleted_node(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'alive'], 100));
        $this->applier->apply($this->op('node.delete', ['id' => $id], 200));
        $this->assertTrue(Node::withTrashed()->find($id)->trashed());

        $this->applier->apply($this->set($id, ['content' => 'revived'], 300));

        $node = Node::find($id);
        $this->assertNotNull($node);
        $this->assertSame('revived', $node->content);
    }

    public function test_edit_with_older_hlc_stays_deleted(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'alive'], 100));
        $this->applier->apply($this->op('node.delete', ['id' => $id], 300));
        $this->applier->apply($this->set($id, ['content' => 'stale edit'], 200));

        $node = Node::withTrashed()->find($id);
        $this->assertTrue($node->trashed());
        // The stale edit's content still lands (content clock was older) —
        // only liveness lost the LWW race
        $this->assertSame('stale edit', $node->content);
    }

    public function test_purge_is_terminal_even_against_newer_ops(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'secret'], 100));
        $this->applier->apply($this->op('node.purge', ['id' => $id], 200));
        $this->applier->apply($this->set($id, ['content' => 'resurrection attempt'], 99999));

        $node = Node::withTrashed()->find($id);
        $this->assertTrue($node->purged);
        $this->assertSame('', $node->content);
        $this->assertNull($node->tiptap_content);
        $this->assertTrue($node->trashed());
    }

    public function test_set_arriving_before_create_converges(): void
    {
        $id = fake()->uuid();

        // Partial update arrives first (permuted delivery), then the create
        $this->applier->apply($this->set($id, ['is_checked' => true], 200));
        $this->applier->apply($this->set($id, ['content' => 'created', 'position' => 'a3'], 100));

        $node = Node::find($id);
        $this->assertSame('created', $node->content);
        $this->assertSame('a3', $node->position);
        $this->assertTrue($node->is_checked);
    }

    public function test_child_moved_out_survives_subtree_delete(): void
    {
        $pageA = fake()->uuid();
        $pageB = fake()->uuid();
        $child = fake()->uuid();

        $this->applier->apply($this->set($pageA, ['content' => 'A'], 10));
        $this->applier->apply($this->set($pageB, ['content' => 'B'], 11));
        $this->applier->apply($this->set($child, ['parent_id' => $pageA, 'content' => 'kid'], 12));

        // Concurrent: child moved to B, then A deleted
        $this->applier->apply($this->set($child, ['parent_id' => $pageB], 100));
        $this->applier->apply($this->op('node.delete', ['id' => $pageA], 101));

        $this->assertFalse(Node::withTrashed()->find($pageA)->isReachable());
        $this->assertTrue(Node::find($child)->isReachable());
    }

    public function test_child_left_inside_deleted_subtree_is_unreachable(): void
    {
        $page = fake()->uuid();
        $child = fake()->uuid();

        $this->applier->apply($this->set($page, ['content' => 'Page'], 10));
        $this->applier->apply($this->set($child, ['parent_id' => $page, 'content' => 'kid'], 11));
        $this->applier->apply($this->op('node.delete', ['id' => $page], 100));

        // The child row itself is not trashed — visibility is derived
        $child = Node::find($child);
        $this->assertNotNull($child);
        $this->assertFalse($child->isReachable());
    }

    public function test_parent_cycle_is_unreachable_not_infinite(): void
    {
        $a = fake()->uuid();
        $b = fake()->uuid();

        $this->applier->apply($this->set($a, ['content' => 'a'], 10));
        $this->applier->apply($this->set($b, ['parent_id' => $a, 'content' => 'b'], 11));
        // Concurrent move on another device: a under b — creates a cycle
        $this->applier->apply($this->set($a, ['parent_id' => $b], 100));

        $this->assertFalse(Node::find($a)->isReachable());
        $this->assertFalse(Node::find($b)->isReachable());
    }

    public function test_null_content_and_position_are_coerced_not_fatal(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'real'], 100));
        // A buggy or malicious op must not wedge the log with NOT NULL
        // constraint failures
        $this->applier->apply($this->set($id, ['content' => null, 'position' => null], 200));

        $node = Node::find($id);
        $this->assertSame('', $node->content);
        $this->assertSame('a0', $node->position);
    }

    public function test_empty_fields_set_acts_as_pure_revive(): void
    {
        $id = fake()->uuid();

        $this->applier->apply($this->set($id, ['content' => 'alive'], 100));
        $this->applier->apply($this->op('node.delete', ['id' => $id], 200));
        $this->applier->apply($this->set($id, [], 300));

        $this->assertFalse(Node::withTrashed()->find($id)->trashed());
    }
}
