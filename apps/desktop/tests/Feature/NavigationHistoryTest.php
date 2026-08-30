<?php

namespace Tests\Feature;

use App\Accounts\CloudAccountStore;
use App\Models\Node;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Tests\TestCase;

class NavigationHistoryTest extends TestCase
{
    use RefreshDatabase;

    private CloudAccountStore $account;

    private string $directory;

    protected function setUp(): void
    {
        parent::setUp();

        $this->directory = sys_get_temp_dir().'/yeidle-navigation-'.Str::uuid();
        $this->account = new CloudAccountStore($this->directory.'/account.json');
        $this->app->instance(CloudAccountStore::class, $this->account);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->directory);

        parent::tearDown();
    }

    public function test_it_persists_a_local_navigation_tree(): void
    {
        Node::query()->create([
            'id' => '00000000-0000-7000-8000-000000000010',
            'position' => 'a0',
            'content' => 'Page title',
        ]);
        Node::query()->create([
            'id' => '00000000-0000-7000-8000-000000000011',
            'parent_id' => '00000000-0000-7000-8000-000000000010',
            'position' => 'a0',
            'content' => 'The selected node text',
        ]);
        $root = $this->location('00000000-0000-7000-8000-000000000001');
        $child = $this->location(
            '00000000-0000-7000-8000-000000000002',
            $root['id'],
        );

        $this->putJson('/api/navigation-history/locations/'.$root['id'], [
            ...$root,
            'make_current' => true,
        ])->assertSuccessful();
        $this->putJson('/api/navigation-history/locations/'.$child['id'], [
            ...$child,
            'make_current' => true,
        ])
            ->assertSuccessful()
            ->assertJsonPath('parent_id', $root['id'])
            ->assertJsonPath('block_id', $child['block_id'])
            ->assertJsonPath('cursor_offset', 12)
            ->assertJsonPath('selection_type', 'node');

        $this->getJson('/api/navigation-history')
            ->assertSuccessful()
            ->assertJsonCount(2, 'locations')
            ->assertJsonPath('locations.0.id', $root['id'])
            ->assertJsonPath('locations.1.parent_id', $root['id'])
            ->assertJsonPath('locations.1.scroll_top', 480)
            ->assertJsonPath('locations.1.page_title', 'Page title')
            ->assertJsonPath('locations.1.node_text', 'The selected node text')
            ->assertJsonPath('current_id', $child['id']);

        $this->putJson('/api/navigation-history/current', ['id' => $root['id']])
            ->assertSuccessful()
            ->assertJsonPath('current_id', $root['id']);

        $this->assertDatabaseCount('navigation_locations', 2);
        $this->assertDatabaseCount('navigation_history_states', 1);
        $this->assertDatabaseCount('ops', 0);
    }

    public function test_histories_are_isolated_by_cloud_user(): void
    {
        $this->account->saveAccount(['user' => ['id' => 'user-a']]);
        $location = $this->location('00000000-0000-7000-8000-000000000003');

        $this->putJson('/api/navigation-history/locations/'.$location['id'], [
            ...$location,
            'make_current' => true,
        ])->assertSuccessful();

        $this->account->saveAccount(['user' => ['id' => 'user-b']]);
        $this->getJson('/api/navigation-history')
            ->assertJsonPath('locations', [])
            ->assertJsonPath('current_id', null);

        $this->account->saveAccount(['user' => ['id' => 'user-a']]);
        $this->getJson('/api/navigation-history')
            ->assertJsonPath('locations.0.id', $location['id'])
            ->assertJsonPath('current_id', $location['id']);
    }

    public function test_it_does_not_persist_the_navigation_history_page(): void
    {
        $location = $this->location('00000000-0000-7000-8000-000000000004');

        $this->putJson('/api/navigation-history/locations/'.$location['id'], [
            ...$location,
            'url' => '/navigation-history',
            'page_id' => null,
            'block_id' => null,
            'cursor_offset' => null,
            'make_current' => true,
        ])->assertNoContent();

        $this->getJson('/api/navigation-history')
            ->assertJsonPath('locations', [])
            ->assertJsonPath('current_id', null);
    }

    public function test_it_normalizes_the_nativephp_window_url(): void
    {
        $location = $this->location('00000000-0000-7000-8000-000000000005');

        $this->putJson('/api/navigation-history/locations/'.$location['id'], [
            ...$location,
            'url' => '/?_windowId=main',
            'page_id' => null,
            'block_id' => null,
            'cursor_offset' => null,
            'selection_type' => null,
            'make_current' => true,
        ])->assertSuccessful();

        $this->getJson('/api/navigation-history')
            ->assertJsonPath('locations.0.url', '/pages')
            ->assertJsonPath('current_id', $location['id']);
    }

    public function test_it_clears_navigation_history(): void
    {
        $location = $this->location('00000000-0000-7000-8000-000000000006');

        $this->putJson('/api/navigation-history/locations/'.$location['id'], [
            ...$location,
            'make_current' => true,
        ])->assertSuccessful();

        $this->deleteJson('/api/navigation-history')->assertNoContent();

        $this->getJson('/api/navigation-history')
            ->assertJsonPath('locations', [])
            ->assertJsonPath('current_id', null);
        $this->assertDatabaseCount('navigation_locations', 0);
        $this->assertDatabaseCount('navigation_history_states', 0);
    }

    /** @return array<string, mixed> */
    private function location(string $id, ?string $parentId = null): array
    {
        return [
            'id' => $id,
            'parent_id' => $parentId,
            'url' => '/pages/00000000-0000-7000-8000-000000000010',
            'page_id' => '00000000-0000-7000-8000-000000000010',
            'block_id' => '00000000-0000-7000-8000-000000000011',
            'cursor_offset' => 12,
            'selection_type' => 'node',
            'scroll_top' => 480,
            'visited_at' => '2026-08-30T03:00:00+02:00',
            'last_visited_at' => '2026-08-30T03:00:00+02:00',
        ];
    }
}
