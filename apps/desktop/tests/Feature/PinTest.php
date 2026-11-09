<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\Op;
use App\Models\SyncState;
use App\Support\PinNodes;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PinTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_node_can_be_pinned_and_unpinned_through_synced_nodes(): void
    {
        $page = $this->page('00000000-0000-7000-8000-000000000001', 'Saved page');

        $empty = $this->getJson('/api/pins')->assertSuccessful();
        $empty->assertJsonPath('items', []);
        $rootId = $empty->json('root_id');

        $this->putJson("/api/nodes/{$page->id}/pin")
            ->assertSuccessful()
            ->assertJson(['pinned' => true]);

        $this->assertDatabaseHas('nodes', [
            'id' => PinNodes::ROOT_ID,
            'parent_id' => null,
        ]);
        $this->assertDatabaseHas('nodes', [
            'id' => $rootId,
            'parent_id' => PinNodes::ROOT_ID,
        ]);
        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => $page->id,
            'position' => 'a0',
        ]);
        $this->assertGreaterThan(0, Op::whereNull('server_seq')->count());

        $this->getJson('/api/pins')
            ->assertSuccessful()
            ->assertJsonPath('items.0.id', $page->id)
            ->assertJsonPath('items.0.content', 'Saved page');

        $this->deleteJson("/api/nodes/{$page->id}/pin")
            ->assertSuccessful()
            ->assertJson(['pinned' => false]);

        $this->getJson('/api/pins')
            ->assertJsonPath('items', []);
        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => $page->id,
        ]);
        $this->assertNotNull(
            Node::withTrashed()->where('parent_id', $rootId)->where('content', $page->id)->sole()->deleted_at
        );
    }

    public function test_each_cloud_user_only_sees_their_own_synced_pin_root(): void
    {
        $first = $this->page('00000000-0000-7000-8000-000000000002', 'First user page');
        $second = $this->page('00000000-0000-7000-8000-000000000003', 'Second user page');
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000099',
            'last_server_seq' => 0,
            'cloud_user_id' => 'user-a',
        ]);

        $firstRoot = $this->getJson('/api/pins')->json('root_id');
        $this->putJson("/api/nodes/{$first->id}/pin")->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-b']);
        $secondListing = $this->getJson('/api/pins')->assertSuccessful();
        $secondRoot = $secondListing->json('root_id');
        $secondListing->assertJsonPath('items', []);
        $this->assertNotSame($firstRoot, $secondRoot);

        $this->putJson("/api/nodes/{$second->id}/pin")->assertSuccessful();
        $this->getJson('/api/pins')
            ->assertJsonPath('items.0.id', $second->id);

        $state->update(['cloud_user_id' => 'user-a']);
        $this->getJson('/api/pins')
            ->assertJsonPath('root_id', $firstRoot)
            ->assertJsonPath('items.0.id', $first->id)
            ->assertJsonMissing(['id' => $second->id]);

        $this->assertDatabaseHas('nodes', ['id' => $firstRoot]);
        $this->assertDatabaseHas('nodes', ['id' => $secondRoot]);
    }

    public function test_only_top_level_user_nodes_can_be_pinned(): void
    {
        $page = $this->page('00000000-0000-7000-8000-000000000004', 'Page');
        $child = $this->page('00000000-0000-7000-8000-000000000005', 'Child');
        $child->parent_id = $page->id;
        $child->save();

        $this->putJson("/api/nodes/{$child->id}/pin")->assertNotFound();

        $this->getJson('/api/pins');
        $this->putJson('/api/nodes/'.PinNodes::ROOT_ID.'/pin')->assertNotFound();
    }

    public function test_pins_can_be_reordered_with_node_position_ops(): void
    {
        $first = $this->page('00000000-0000-7000-8000-000000000010', 'First');
        $second = $this->page('00000000-0000-7000-8000-000000000011', 'Second');
        $third = $this->page('00000000-0000-7000-8000-000000000012', 'Third');

        foreach ([$first, $second, $third] as $page) {
            $this->putJson("/api/nodes/{$page->id}/pin")->assertSuccessful();
        }

        $rootId = $this->getJson('/api/pins')->json('root_id');
        $this->putJson('/api/pins/order', [
            'node_ids' => [$third->id, $first->id, $second->id],
        ])->assertSuccessful();

        $this->getJson('/api/pins')
            ->assertJsonPath('items.0.id', $third->id)
            ->assertJsonPath('items.1.id', $first->id)
            ->assertJsonPath('items.2.id', $second->id);

        $positions = Node::where('parent_id', $rootId)
            ->pluck('position', 'content');
        $this->assertSame('a0', $positions[$third->id]);
        $this->assertSame('a1', $positions[$first->id]);
        $this->assertSame('a2', $positions[$second->id]);
    }

    public function test_reorder_rejects_a_stale_pin_list(): void
    {
        $page = $this->page('00000000-0000-7000-8000-000000000020', 'Page');
        $this->putJson("/api/nodes/{$page->id}/pin")->assertSuccessful();

        $this->putJson('/api/pins/order', ['node_ids' => []])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('node_ids');
    }

    public function test_pin_system_nodes_are_hidden_from_pages_and_search(): void
    {
        $page = $this->page('00000000-0000-7000-8000-000000000030', 'Saved page');
        $this->putJson("/api/nodes/{$page->id}/pin")->assertSuccessful();

        $this->getJson('/api/pages')
            ->assertJsonFragment(['id' => $page->id])
            ->assertJsonMissing(['id' => PinNodes::ROOT_ID]);
        $this->get('/pages/'.PinNodes::ROOT_ID)->assertNotFound();
        $this->getJson('/api/search?q='.$page->id)
            ->assertJsonMissing(['content' => $page->id]);
    }

    private function page(string $id, string $content): Node
    {
        $page = new Node;
        $page->id = $id;
        $page->content = $content;
        $page->position = 'a0';
        $page->modified_hlc = '000000000000100-0000-test';
        $page->save();

        return $page;
    }
}
