<?php

namespace Tests\Feature;

use App\Models\Node;
use Illuminate\Foundation\Testing\RefreshDatabase;
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
}
