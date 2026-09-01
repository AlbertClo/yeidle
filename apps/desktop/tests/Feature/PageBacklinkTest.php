<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Models\NodeLink;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class PageBacklinkTest extends TestCase
{
    use RefreshDatabase;

    public function test_backlinks_are_included_in_the_initial_page_response(): void
    {
        $target = $this->node('Target page');
        $sourcePage = $this->node('Source page');
        $sourceParent = $this->node('Parent block', $sourcePage->id);
        $sourceBlock = $this->node('Linked block', $sourceParent->id);
        $link = NodeLink::create([
            'source_node_id' => $sourceBlock->id,
            'target_node_id' => $target->id,
        ]);

        $this->get('/pages/'.$target->id)
            ->assertSuccessful()
            ->assertInertia(fn (Assert $response) => $response
                ->component('Pages/Show')
                ->where('backlinks.0.id', $link->id)
                ->where('backlinks.0.page_id', $sourcePage->id)
                ->where('backlinks.0.page_title', 'Source page'));
    }

    private function node(string $content, ?string $parentId = null): Node
    {
        $node = new Node;
        $node->id = fake()->uuid();
        $node->parent_id = $parentId;
        $node->content = $content;
        $node->position = 'a0';
        $node->modified_hlc = '000000000000100-0000-a';
        $node->save();

        return $node;
    }
}
