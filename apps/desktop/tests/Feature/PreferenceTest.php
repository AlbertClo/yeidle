<?php

namespace Tests\Feature;

use App\Models\Op;
use App\Models\SyncState;
use App\Support\PreferenceNodes;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PreferenceTest extends TestCase
{
    use RefreshDatabase;

    public function test_light_is_the_default_theme_without_a_saved_preference(): void
    {
        $this->get('/pages')
            ->assertSuccessful()
            ->assertSee('data-theme="light"', false);
    }

    public function test_theme_is_stored_in_synced_preference_nodes(): void
    {
        $empty = $this->getJson('/api/preferences')->assertSuccessful();
        $empty->assertJsonPath('theme', null);
        $rootId = $empty->json('root_id');

        $this->putJson('/api/preferences/theme', ['theme' => 'light'])
            ->assertSuccessful()
            ->assertJsonPath('theme', 'light');

        $this->assertDatabaseHas('nodes', [
            'id' => PreferenceNodes::ROOT_ID,
            'parent_id' => null,
        ]);
        $this->assertDatabaseHas('nodes', [
            'id' => $rootId,
            'parent_id' => PreferenceNodes::ROOT_ID,
        ]);
        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => 'light',
            'position' => 'a0',
        ]);
        $this->assertGreaterThan(0, Op::whereNull('server_seq')->count());

        $this->getJson('/api/preferences')
            ->assertSuccessful()
            ->assertJsonPath('theme', 'light');
    }

    public function test_typography_is_stored_in_synced_preference_nodes(): void
    {
        $empty = $this->getJson('/api/preferences')->assertSuccessful();
        $empty->assertJsonPath('font_family', null);
        $empty->assertJsonPath('font_size', null);
        $rootId = $empty->json('root_id');

        $this->putJson('/api/preferences/typography', [
            'font_family' => 'source-serif-4',
            'font_size' => 18,
        ])
            ->assertSuccessful()
            ->assertJsonPath('font_family', 'source-serif-4')
            ->assertJsonPath('font_size', 18);

        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => 'source-serif-4',
            'position' => 'a1',
        ]);
        $this->assertDatabaseHas('nodes', [
            'parent_id' => $rootId,
            'content' => '18',
            'position' => 'a2',
        ]);
        $this->assertGreaterThan(0, Op::whereNull('server_seq')->count());
    }

    public function test_theme_is_scoped_to_the_active_cloud_user(): void
    {
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000099',
            'last_server_seq' => 0,
            'cloud_user_id' => 'user-a',
        ]);

        $this->putJson('/api/preferences/theme', ['theme' => 'light'])
            ->assertSuccessful();
        $firstRoot = $this->getJson('/api/preferences')->json('root_id');

        $state->update(['cloud_user_id' => 'user-b']);
        $secondListing = $this->getJson('/api/preferences')->assertSuccessful();
        $secondRoot = $secondListing->json('root_id');
        $secondListing->assertJsonPath('theme', null);
        $this->assertNotSame($firstRoot, $secondRoot);

        $this->putJson('/api/preferences/theme', ['theme' => 'dark'])
            ->assertSuccessful();

        $state->update(['cloud_user_id' => 'user-a']);
        $this->getJson('/api/preferences')
            ->assertJsonPath('root_id', $firstRoot)
            ->assertJsonPath('theme', 'light');
    }

    public function test_local_preferences_are_adopted_when_a_cloud_user_is_known(): void
    {
        $state = SyncState::create([
            'client_id' => '00000000-0000-7000-8000-000000000098',
            'last_server_seq' => 0,
        ]);

        $this->putJson('/api/preferences/theme', ['theme' => 'light'])
            ->assertSuccessful();
        $localRoot = $this->getJson('/api/preferences')->json('root_id');

        $state->update(['cloud_user_id' => 'user-a']);
        $cloudListing = $this->getJson('/api/preferences')->assertSuccessful();
        $cloudListing->assertJsonPath('theme', 'light');
        $this->assertNotSame($localRoot, $cloudListing->json('root_id'));
        $this->assertSoftDeleted('nodes', ['id' => $localRoot]);
    }

    public function test_theme_validation_and_system_node_visibility(): void
    {
        $this->putJson('/api/preferences/theme', ['theme' => 'sepia'])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('theme');

        $this->putJson('/api/preferences/theme', ['theme' => 'light'])
            ->assertSuccessful();

        $this->getJson('/api/pages')
            ->assertJsonMissing(['id' => PreferenceNodes::ROOT_ID]);
        $this->get('/pages/'.PreferenceNodes::ROOT_ID)->assertNotFound();
        $this->getJson('/api/search?q=light')
            ->assertJsonMissing(['content' => 'light']);
    }

    public function test_typography_validation(): void
    {
        $this->putJson('/api/preferences/typography', [
            'font_family' => 'comic-sans',
            'font_size' => 16,
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('font_family');

        $this->putJson('/api/preferences/typography', [
            'font_family' => 'instrument-sans',
            'font_size' => PreferenceNodes::MAX_FONT_SIZE + 1,
        ])
            ->assertUnprocessable()
            ->assertJsonValidationErrors('font_size');
    }

    public function test_bundled_font_families_are_available(): void
    {
        foreach (['source-serif-4', 'atkinson-hyperlegible', 'jetbrains-mono'] as $fontFamily) {
            $this->putJson('/api/preferences/typography', [
                'font_family' => $fontFamily,
                'font_size' => 16,
            ])
                ->assertSuccessful()
                ->assertJsonPath('font_family', $fontFamily);
        }
    }

    public function test_named_themes_are_accepted_and_returned(): void
    {
        foreach (PreferenceNodes::THEMES as $theme) {
            $this->putJson('/api/preferences/theme', ['theme' => $theme])
                ->assertSuccessful()
                ->assertJsonPath('theme', $theme);
        }
    }
}
