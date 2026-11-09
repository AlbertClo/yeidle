<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\Op;
use App\Models\SyncState;
use App\Support\CollapsedNodes;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CollapsedNodeTest extends TestCase
{
    use RefreshDatabase;

    public function test_collapse_state_is_stored_as_personal_synced_nodes(): void
    {
        [$page, $parent] = $this->tree();

        $empty = $this->getJson('/api/collapsed-nodes')->assertSuccessful();
        $rootId = $empty->json('root_id');
        $empty->assertJsonPath('node_ids', []);

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful()->assertJsonPath('node_ids.0', $parent->id);

        $this->assertDatabaseHas('nodes', [
            'id' => CollapsedNodes::ROOT_ID,
            'parent_id' => null,
        ]);
        $this->assertDatabaseHas('nodes', [
            'id' => $rootId,
            'parent_id' => CollapsedNodes::ROOT_ID,
        ]);
        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => $parent->id,
        ]);
        $this->assertGreaterThan(0, Op::whereNull('server_seq')->count());

        $this->get('/pages/'.$page->id)
            ->assertSuccessful()
            ->assertInertia(fn ($response) => $response
                ->where('collapsedNodeIds', [$parent->id])
                ->where('collapsedNodesRootId', $rootId));
    }

    public function test_expanding_a_node_preserves_descendant_state(): void
    {
        [, $parent, $child] = $this->tree();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful();
        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$child->id],
            'collapsed' => true,
        ])->assertSuccessful();
        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => false,
        ])->assertSuccessful()->assertJsonPath('node_ids', [$child->id]);

        $rootId = $this->getJson('/api/collapsed-nodes')->json('root_id');
        $entry = Node::withTrashed()
            ->where('parent_id', $rootId)
            ->where('content', $child->id)
            ->sole();
        $this->assertNull($entry->deleted_at);
    }

    public function test_collapsing_a_parent_preserves_descendant_folds(): void
    {
        [, $parent, $child] = $this->tree();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$child->id],
            'collapsed' => true,
        ])->assertSuccessful();
        $response = $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $this->assertEqualsCanonicalizing(
            [$parent->id, $child->id],
            $response->json('node_ids'),
        );
    }

    public function test_multiple_nodes_can_be_collapsed_in_one_request(): void
    {
        [, $parent, $child] = $this->tree();

        $response = $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id, $child->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $this->assertEqualsCanonicalizing(
            [$parent->id, $child->id],
            $response->json('node_ids'),
        );
    }

    public function test_multiple_ancestor_paths_can_be_expanded_in_one_request(): void
    {
        [, $parent, $child] = $this->tree();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id, $child->id],
            'collapsed' => false,
        ])->assertSuccessful()->assertJsonPath('node_ids', []);
    }

    public function test_each_cloud_user_only_sees_their_own_collapsed_nodes(): void
    {
        [, $parent, $child] = $this->tree();
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000099',
            'last_server_seq' => 0,
            'cloud_user_id' => 'user-a',
        ]);

        $firstRoot = $this->getJson('/api/collapsed-nodes')->json('root_id');
        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-b']);
        $second = $this->getJson('/api/collapsed-nodes')->assertSuccessful();
        $this->assertNotSame($firstRoot, $second->json('root_id'));
        $second->assertJsonPath('node_ids', []);

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$child->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-a']);
        $this->getJson('/api/collapsed-nodes')
            ->assertJsonPath('node_ids', [$parent->id]);
    }

    public function test_pages_and_system_nodes_cannot_be_collapsed(): void
    {
        [$page, $parent] = $this->tree();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$page->id],
            'collapsed' => true,
        ])->assertNotFound();

        $this->putJson('/api/collapsed-nodes', [
            'node_ids' => [$parent->id],
            'collapsed' => true,
        ])->assertSuccessful();

        $this->getJson('/api/pages')
            ->assertJsonMissing(['id' => CollapsedNodes::ROOT_ID]);
        $this->get('/pages/'.CollapsedNodes::ROOT_ID)->assertNotFound();
    }

    /** @return array{Node, Node, Node} */
    private function tree(): array
    {
        $page = $this->node('00000000-0000-7000-8000-000000000001', null, 'Page');
        $parent = $this->node('00000000-0000-7000-8000-000000000002', $page->id, 'Parent');
        $child = $this->node('00000000-0000-7000-8000-000000000003', $parent->id, 'Child');

        return [$page, $parent, $child];
    }

    private function node(string $id, ?string $parentId, string $content): Node
    {
        return Node::create([
            'id' => $id,
            'parent_id' => $parentId,
            'content' => $content,
            'position' => 'a0',
            'modified_hlc' => '000000000000100-0000-test',
        ]);
    }
}
