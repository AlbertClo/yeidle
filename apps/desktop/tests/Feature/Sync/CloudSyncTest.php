<?php

namespace Tests\Feature\Sync;

use App\Models\Node;
use App\Models\Op;
use App\Models\SyncState;
use App\Sync\HlcGenerator;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Tests\TestCase;

class CloudSyncTest extends TestCase
{
    use RefreshDatabase;

    private const CLOUD = 'https://cloud.test';

    private function pairedState(int $lastSeq = 0): SyncState
    {
        return SyncState::create([
            'client_id' => fake()->uuid(),
            'last_server_seq' => $lastSeq,
            'cloud_url' => self::CLOUD,
            'cloud_token' => 'test-token',
        ]);
    }

    private function remoteOp(string $type, array $payload, int $serverSeq, int $millis): array
    {
        return [
            'server_seq' => $serverSeq,
            'op_id' => fake()->uuid(),
            'client_id' => 'other-machine',
            'hlc' => HlcGenerator::encode($millis, 0, 'other-machine'),
            'type' => $type,
            'payload' => $payload,
        ];
    }

    public function test_exchange_without_configuration_is_a_noop(): void
    {
        Http::fake();

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk();
        $this->assertFalse($response->json('configured'));
        Http::assertNothingSent();
    }

    public function test_exchange_pushes_the_outbox_and_records_server_seq(): void
    {
        $this->pairedState();

        $id = fake()->uuid();
        $this->postJson('/api/sync/push', ['client_id' => 'win', 'ops' => [[
            'op_id' => $opId = fake()->uuid(),
            'client_id' => 'win',
            'hlc' => HlcGenerator::encode(100, 0, 'win'),
            'type' => 'node.set',
            'payload' => ['v' => 1, 'id' => $id, 'page_id' => $id, 'fields' => ['content' => 'local edit']],
        ]]])->assertOk();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response([
                'accepted' => [['op_id' => $opId, 'server_seq' => 41]],
            ]),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 41]),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk();
        $this->assertSame(1, $response->json('pushed'));
        $this->assertSame(41, Op::where('op_id', $opId)->sole()->server_seq);
        $this->assertSame(41, (int) SyncState::current()->last_server_seq);
    }

    public function test_exchange_applies_pulled_remote_ops_and_advances_cursor(): void
    {
        $this->pairedState();
        $nodeId = fake()->uuid();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => []]),
            self::CLOUD.'/api/sync/pull*' => Http::sequence()
                ->push([
                    'ops' => [$this->remoteOp('node.set', [
                        'v' => 1, 'id' => $nodeId, 'page_id' => $nodeId,
                        'fields' => ['parent_id' => null, 'position' => 'a0', 'content' => 'from the other machine'],
                    ], 7, 500)],
                    'latest_seq' => 7,
                ])
                ->push(['ops' => [], 'latest_seq' => 7]),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk();
        $this->assertSame(1, $response->json('pulled'));
        $this->assertSame('from the other machine', Node::find($nodeId)->content);
        // Landed in the local log so open editors receive it via the local pull
        $this->assertSame(7, Op::latest('id')->first()->server_seq);
        $this->assertSame(7, (int) SyncState::current()->last_server_seq);
    }

    public function test_own_ops_returning_from_the_cloud_are_not_reapplied(): void
    {
        $this->pairedState();

        $id = fake()->uuid();
        $opId = fake()->uuid();
        $hlc = HlcGenerator::encode(100, 0, 'win');
        $this->postJson('/api/sync/push', ['client_id' => 'win', 'ops' => [[
            'op_id' => $opId, 'client_id' => 'win', 'hlc' => $hlc,
            'type' => 'node.set',
            'payload' => ['v' => 1, 'id' => $id, 'page_id' => $id, 'fields' => ['content' => 'mine']],
        ]]])->assertOk();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => [['op_id' => $opId, 'server_seq' => 3]]]),
            self::CLOUD.'/api/sync/pull*' => Http::sequence()
                ->push([
                    'ops' => [[
                        'server_seq' => 3, 'op_id' => $opId, 'client_id' => 'win', 'hlc' => $hlc,
                        'type' => 'node.set',
                        'payload' => ['v' => 1, 'id' => $id, 'page_id' => $id, 'fields' => ['content' => 'mine']],
                    ]],
                    'latest_seq' => 3,
                ])
                ->push(['ops' => [], 'latest_seq' => 3]),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $this->assertSame(0, $response->json('pulled'));
        $this->assertSame(1, Op::count());
    }

    public function test_connect_seeds_an_empty_cloud_from_local_data(): void
    {
        // Local data exists but no ops (genesis state)
        $pageId = fake()->uuid();
        $node = new Node;
        $node->id = $pageId;
        $node->content = 'Existing Page';
        $node->position = 'a0';
        $node->save();

        Http::fake([
            self::CLOUD.'/api/sync/status' => Http::response(['workspace_id' => 'w', 'latest_seq' => 0]),
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => []]),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 1]),
        ]);

        $response = $this->postJson('/api/cloud/connect', [
            'url' => self::CLOUD,
            'token' => 'test-token',
        ]);

        $response->assertOk();
        $this->assertTrue($response->json('seeded'));

        Http::assertSent(function ($request) use ($pageId) {
            if (! str_contains($request->url(), '/api/sync/push')) {
                return false;
            }

            $ops = collect($request['ops']);

            return $ops->contains(fn ($op) => $op['type'] === 'node.set'
                && $op['payload']['id'] === $pageId
                && $op['payload']['fields']['content'] === 'Existing Page');
        });
    }

    public function test_connect_bootstraps_a_fresh_install_from_the_cloud(): void
    {
        $pageId = fake()->uuid();
        $childId = fake()->uuid();

        Http::fake([
            self::CLOUD.'/api/sync/status' => Http::response(['workspace_id' => 'w', 'latest_seq' => 12]),
            self::CLOUD.'/api/sync/bootstrap' => Http::response([
                'latest_seq' => 12,
                'nodes' => [
                    // Child listed first: bootstrap must order parents first
                    ['id' => $childId, 'parent_id' => $pageId, 'position' => 'a0', 'content' => 'child',
                        'tiptap_content' => null, 'is_checked' => null,
                        'field_clocks' => ['content' => '000000000000100-0000-x'], 'purged' => false, 'deleted_at' => null],
                    ['id' => $pageId, 'parent_id' => null, 'position' => 'a0', 'content' => 'Cloud Page',
                        'tiptap_content' => null, 'is_checked' => null,
                        'field_clocks' => null, 'purged' => false, 'deleted_at' => null],
                ],
                'media' => [],
            ]),
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => []]),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 12]),
        ]);

        $response = $this->postJson('/api/cloud/connect', [
            'url' => self::CLOUD,
            'token' => 'test-token',
        ]);

        $response->assertOk();
        $this->assertTrue($response->json('bootstrapped'));
        $this->assertSame('Cloud Page', Node::find($pageId)->content);
        $this->assertSame($pageId, Node::find($childId)->parent_id);
        $this->assertSame(12, (int) SyncState::current()->last_server_seq);
    }

    public function test_connect_refuses_when_both_sides_have_unpaired_data(): void
    {
        $node = new Node;
        $node->id = fake()->uuid();
        $node->content = 'local data';
        $node->position = 'a0';
        $node->save();

        Http::fake([
            self::CLOUD.'/api/sync/status' => Http::response(['workspace_id' => 'w', 'latest_seq' => 5]),
        ]);

        $this->postJson('/api/cloud/connect', ['url' => self::CLOUD, 'token' => 't'])
            ->assertStatus(422);

        $this->assertNull(SyncState::current());
    }
}
