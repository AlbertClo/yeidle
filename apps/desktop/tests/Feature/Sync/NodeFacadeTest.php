<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use App\Models\Op;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class NodeFacadeTest extends TestCase
{
    use RefreshDatabase;

    public function test_creating_a_page_mints_an_op(): void
    {
        $response = $this->postJson('/api/nodes', ['content' => 'My New Page']);

        $response->assertStatus(201);
        $id = $response->json('id');

        $this->assertSame('My New Page', Node::find($id)->content);

        $op = Op::sole();
        $this->assertSame('node.set', $op->type);
        $this->assertSame($id, $op->payload['id']);
        // A page's ops carry its own id as page_id
        $this->assertSame($id, $op->payload['page_id']);
        $this->assertStringStartsWith('srv-', $op->client_id);
    }

    public function test_duplicate_page_title_returns_existing_without_minting(): void
    {
        $first = $this->postJson('/api/nodes', ['content' => 'Unique Title']);
        $second = $this->postJson('/api/nodes', ['content' => 'unique title']);

        $second->assertStatus(200);
        $this->assertSame($first->json('id'), $second->json('id'));
        $this->assertSame(1, Op::count());
    }

    public function test_child_create_carries_the_root_page_id(): void
    {
        $page = $this->postJson('/api/nodes', ['content' => 'Parent Page'])->json('id');
        $child = $this->postJson('/api/nodes', [
            'parent_id' => $page,
            'content' => 'child node',
            'position' => 'a0',
        ]);

        $child->assertStatus(201);
        $op = Op::orderByDesc('id')->first();
        $this->assertSame($page, $op->payload['page_id']);
    }

    public function test_create_with_known_id_is_an_upsert(): void
    {
        $id = fake()->uuid();

        $this->postJson('/api/nodes', ['id' => $id, 'content' => 'v1'])->assertStatus(201);
        $again = $this->postJson('/api/nodes', ['id' => $id, 'content' => 'v2', 'parent_id' => null]);

        // Same title-less upsert path: existing id means 200, and the newer
        // op wins the content field
        $again->assertStatus(200);
        $this->assertSame('v2', Node::find($id)->content);
    }

    public function test_legacy_endpoints_are_gone(): void
    {
        $id = fake()->uuid();
        $this->postJson('/api/nodes', ['id' => $id, 'content' => 'x']);

        $this->putJson("/api/nodes/{$id}", ['content' => 'y'])->assertStatus(404);
        $this->deleteJson("/api/nodes/{$id}")->assertStatus(404);
        $this->postJson('/api/nodes/batch', ['upserts' => [], 'deletes' => []])->assertStatus(404);
    }
}
