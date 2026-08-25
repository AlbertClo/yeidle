<?php

namespace Tests\Feature;

use App\Models\Node;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SearchTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_ranks_exact_pages_before_blocks_and_prefix_matches(): void
    {
        $container = $this->node('Container');
        $prefixPage = $this->node('Research Notes', modifiedHlc: '000000000000300-0000-a');
        $exactBlock = $this->node('Research', $container->id, '000000000000200-0000-a');
        $exactPage = $this->node('Research', modifiedHlc: '000000000000100-0000-a');

        $this->getJson('/api/search?q=Research')
            ->assertOk()
            ->assertJsonPath('0.id', $exactPage->id)
            ->assertJsonPath('1.id', $exactBlock->id)
            ->assertJsonPath('2.id', $prefixPage->id);
    }

    public function test_it_finds_long_and_short_typographical_errors(): void
    {
        $research = $this->node('Research Projects');
        $cat = $this->node('Cat');
        $the = $this->node('The');

        $this->getJson('/api/search?q=Reserch')
            ->assertOk()
            ->assertJsonPath('0.id', $research->id);

        $this->getJson('/api/search?q=Cet')
            ->assertOk()
            ->assertJsonPath('0.id', $cat->id);

        $this->getJson('/api/search?q=Teh')
            ->assertOk()
            ->assertJsonPath('0.id', $the->id);
    }

    public function test_it_matches_sequential_word_prefixes(): void
    {
        $currentPriority = $this->node('Current Priority');

        $this->getJson('/api/search?q=cur%20prio')
            ->assertOk()
            ->assertJsonPath('0.id', $currentPriority->id);
    }

    public function test_the_index_tracks_content_updates_deletes_and_restores(): void
    {
        $page = $this->node('Original title');

        $this->getJson('/api/search?q=Original')->assertJsonPath('0.id', $page->id);

        $page->content = 'Replacement title';
        $page->save();

        $this->getJson('/api/search?q=Original')->assertExactJson([]);
        $this->getJson('/api/search?q=Replacement')->assertJsonPath('0.id', $page->id);

        $page->delete();
        $this->getJson('/api/search?q=Replacement')->assertExactJson([]);

        $page->restore();
        $this->getJson('/api/search?q=Replacement')->assertJsonPath('0.id', $page->id);
    }

    public function test_the_search_migration_backfills_existing_nodes(): void
    {
        $migration = require database_path('migrations/2026_08_25_000000_create_node_search_index.php');
        $migration->down();
        $page = $this->node('Pre-existing searchable page');
        $migration->up();

        $this->getJson('/api/search?q=existing')
            ->assertOk()
            ->assertJsonPath('0.id', $page->id);
    }

    public function test_it_excludes_matches_inside_deleted_subtrees(): void
    {
        $page = $this->node('Deleted page');
        $this->node('Hidden searchable phrase', $page->id);
        $page->delete();

        $this->getJson('/api/search?q=searchable')->assertExactJson([]);
    }

    public function test_punctuation_only_queries_return_no_results(): void
    {
        $this->node('Any page');

        $this->getJson('/api/search?q=---')->assertExactJson([]);
    }

    private function node(
        string $content,
        ?string $parentId = null,
        string $modifiedHlc = '000000000000100-0000-a',
    ): Node {
        $node = new Node;
        $node->id = fake()->uuid();
        $node->parent_id = $parentId;
        $node->content = $content;
        $node->position = 'a0';
        $node->modified_hlc = $modifiedHlc;
        $node->save();

        return $node;
    }
}
