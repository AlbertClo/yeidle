<?php

namespace Tests\Feature;

use App\Models\Node;
use App\Services\NodeTreeLoader;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class NodeTreeLoaderTest extends TestCase
{
    use RefreshDatabase;

    public function test_it_loads_an_ordered_nested_tree_with_one_query(): void
    {
        $page = $this->node('00000000-0000-7000-8000-000000000001', null, 'a0');
        $second = $this->node('00000000-0000-7000-8000-000000000002', $page->id, 'b0');
        $first = $this->node('00000000-0000-7000-8000-000000000003', $page->id, 'a0');
        $nested = $this->node('00000000-0000-7000-8000-000000000004', $first->id, 'a0');

        DB::flushQueryLog();
        DB::enableQueryLog();

        $tree = app(NodeTreeLoader::class)->load($page->id);

        $this->assertCount(1, DB::getQueryLog());
        $this->assertSame([$first->id, $second->id], array_column($tree['children'], 'id'));
        $this->assertSame($nested->id, $tree['children'][0]['children'][0]['id']);
        $this->assertCount(0, $tree['children'][0]['children'][0]['children']);
        $this->assertArrayNotHasKey('created_at', $tree['children'][0]);
        $this->assertArrayNotHasKey('modified_hlc', $tree['children'][0]);
    }

    public function test_it_omits_soft_deleted_descendants(): void
    {
        $page = $this->node('00000000-0000-7000-8000-000000000010', null, 'a0');
        $deleted = $this->node('00000000-0000-7000-8000-000000000011', $page->id, 'a0');
        $this->node('00000000-0000-7000-8000-000000000012', $deleted->id, 'a0');
        $deleted->delete();

        $tree = app(NodeTreeLoader::class)->load($page->id);

        $this->assertCount(0, $tree['children']);
    }

    private function node(string $id, ?string $parentId, string $position): Node
    {
        $node = new Node;
        $node->id = $id;
        $node->parent_id = $parentId;
        $node->position = $position;
        $node->content = $id;
        $node->modified_hlc = '000000000000100-0000-a';
        $node->save();

        return $node;
    }
}
