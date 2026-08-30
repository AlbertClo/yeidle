<?php

namespace Tests\Feature;

use App\Models\Node;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class PageOrderingTest extends TestCase
{
    use RefreshDatabase;

    public function test_pages_are_ordered_by_modified_hlc_with_a_deterministic_id_tie_breaker(): void
    {
        $oldest = $this->page('00000000-0000-7000-8000-000000000001', 'Oldest', '000000000000100-0000-a');
        $tieLow = $this->page('00000000-0000-7000-8000-000000000002', 'Tie low', '000000000000200-0000-a');
        $tieHigh = $this->page('00000000-0000-7000-8000-000000000003', 'Tie high', '000000000000200-0000-a');
        $newest = $this->page('00000000-0000-7000-8000-000000000004', 'Newest', '000000000000300-0000-a');

        $this->getJson('/api/pages')
            ->assertSuccessful()
            ->assertJsonPath('0.id', $newest->id)
            ->assertJsonPath('1.id', $tieHigh->id)
            ->assertJsonPath('2.id', $tieLow->id)
            ->assertJsonPath('3.id', $oldest->id);
    }

    public function test_page_index_only_sends_fields_used_by_the_list(): void
    {
        $page = $this->page(
            '00000000-0000-7000-8000-000000000005',
            'Page',
            '000000000000300-0000-a',
        );

        $this->get('/pages')
            ->assertSuccessful()
            ->assertInertia(fn (Assert $response) => $response
                ->component('Pages/Index')
                ->where('pages.0.id', $page->id)
                ->hasAll([
                    'pages.0.content',
                    'pages.0.page_type',
                    'pages.0.daily_note_date',
                    'pages.0.created_at',
                ])
                ->missingAll([
                    'pages.0.parent_id',
                    'pages.0.position',
                    'pages.0.tiptap_content',
                    'pages.0.modified_hlc',
                    'pages.0.updated_at',
                ]));
    }

    public function test_siblings_are_ordered_by_position_with_a_deterministic_id_tie_breaker(): void
    {
        $page = $this->page(
            '00000000-0000-7000-8000-000000000010',
            'Page',
            '000000000000100-0000-a',
        );
        $high = $this->node(
            '00000000-0000-7000-8000-000000000013',
            $page->id,
            'a0',
        );
        $low = $this->node(
            '00000000-0000-7000-8000-000000000012',
            $page->id,
            'a0',
        );

        $this->getJson("/api/pages/{$page->id}")
            ->assertSuccessful()
            ->assertJsonPath('children.0.id', $low->id)
            ->assertJsonPath('children.1.id', $high->id);
    }

    private function page(string $id, string $content, string $modifiedHlc): Node
    {
        $page = new Node;
        $page->id = $id;
        $page->content = $content;
        $page->position = 'a0';
        $page->modified_hlc = $modifiedHlc;
        $page->save();

        return $page;
    }

    private function node(string $id, string $parentId, string $position): Node
    {
        $node = new Node;
        $node->id = $id;
        $node->parent_id = $parentId;
        $node->content = $id;
        $node->position = $position;
        $node->modified_hlc = '000000000000100-0000-a';
        $node->save();

        return $node;
    }
}
