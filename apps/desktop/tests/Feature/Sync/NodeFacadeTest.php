<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class NodeFacadeTest extends TestCase
{
    use RefreshDatabase;

    public function test_creating_a_page_writes_its_document(): void
    {
        $response = $this->postJson('/api/nodes', ['content' => 'My New Page']);

        $response->assertStatus(201);
        $id = $response->json('id');

        $this->assertSame('My New Page', Node::find($id)->content);
        // A page owns the document named after it
        $this->assertSame($id, Node::find($id)->document_id);
        $this->assertSame($id, DB::table('document_updates')->sole()->document_id);
    }

    public function test_duplicate_page_title_returns_existing_without_writing(): void
    {
        $first = $this->postJson('/api/nodes', ['content' => 'Unique Title']);
        $second = $this->postJson('/api/nodes', ['content' => 'unique title']);

        $second->assertStatus(200);
        $this->assertSame($first->json('id'), $second->json('id'));
        $this->assertSame(1, DB::table('document_updates')->count());
    }

    public function test_child_create_lands_in_the_root_page_document(): void
    {
        $page = $this->postJson('/api/nodes', ['content' => 'Parent Page'])->json('id');
        $child = $this->postJson('/api/nodes', [
            'parent_id' => $page,
            'content' => 'child node',
            'position' => 'a0',
        ]);

        $child->assertStatus(201);
        $this->assertSame($page, Node::find($child->json('id'))->document_id);
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

    public function test_reference_endpoint_returns_the_target_subtree_and_root_page(): void
    {
        $page = $this->postJson('/api/nodes', ['content' => 'Reference root'])->json('id');
        $target = $this->postJson('/api/nodes', [
            'parent_id' => $page,
            'content' => 'Referenced block',
        ])->json('id');
        $child = $this->postJson('/api/nodes', [
            'parent_id' => $target,
            'content' => 'Nested block',
        ])->json('id');

        $this->getJson("/api/nodes/{$target}/reference")
            ->assertOk()
            ->assertJsonPath('id', $target)
            ->assertJsonPath('page_id', $page)
            ->assertJsonPath('children.0.id', $child);
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
