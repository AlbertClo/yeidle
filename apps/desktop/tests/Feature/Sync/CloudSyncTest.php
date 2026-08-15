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

    private function queueLocalNodeOp(string $content = 'local edit'): string
    {
        $nodeId = fake()->uuid();
        $opId = fake()->uuid();

        $this->postJson('/api/sync/push', ['client_id' => 'win', 'ops' => [[
            'op_id' => $opId,
            'client_id' => 'win',
            'hlc' => HlcGenerator::encode(100, 0, 'win'),
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $nodeId,
                'page_id' => $nodeId,
                'fields' => ['content' => $content],
            ],
        ]]])->assertOk();

        return $opId;
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

    public function test_empty_acknowledgement_stops_push_and_still_pulls_remote_ops(): void
    {
        $this->pairedState();
        $localOpId = $this->queueLocalNodeOp();
        $remoteNodeId = fake()->uuid();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => []]),
            self::CLOUD.'/api/sync/pull*' => Http::sequence()
                ->push([
                    'ops' => [$this->remoteOp('node.set', [
                        'v' => 1,
                        'id' => $remoteNodeId,
                        'page_id' => $remoteNodeId,
                        'fields' => ['content' => 'remote survives stuck push'],
                    ], 7, 500)],
                    'latest_seq' => 7,
                ])
                ->push(['ops' => [], 'latest_seq' => 7]),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk()
            ->assertJsonPath('ok', false)
            ->assertJsonPath('pushed', 0)
            ->assertJsonPath('pulled', 1);
        $this->assertStringContainsString('acknowledged 0 of 1', $response->json('error'));
        $this->assertNull(Op::where('op_id', $localOpId)->sole()->server_seq);
        $this->assertSame('remote survives stuck push', Node::find($remoteNodeId)->content);
        $this->assertSame(1, Http::recorded(
            fn ($request) => str_ends_with($request->url(), '/api/sync/push')
        )->count());

        $state = SyncState::current();
        $this->assertNotNull($state->last_sync_attempt_at);
        $this->assertNull($state->last_sync_success_at);
        $this->assertSame($response->json('error'), $state->last_sync_error);
    }

    public function test_partial_acknowledgement_is_durable_and_remaining_op_retries_successfully(): void
    {
        $this->pairedState();
        $firstOpId = $this->queueLocalNodeOp('first');
        $secondOpId = $this->queueLocalNodeOp('second');

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::sequence()
                ->push(['accepted' => [['op_id' => $firstOpId, 'server_seq' => 10]]])
                ->push(['accepted' => [['op_id' => $secondOpId, 'server_seq' => 11]]]),
            self::CLOUD.'/api/sync/pull*' => Http::sequence()
                ->push(['ops' => [], 'latest_seq' => 10])
                ->push(['ops' => [], 'latest_seq' => 11]),
        ]);

        $failed = $this->postJson('/api/sync/cloud-exchange');

        $failed->assertOk()
            ->assertJsonPath('ok', false)
            ->assertJsonPath('pushed', 1);
        $this->assertSame(10, Op::where('op_id', $firstOpId)->sole()->server_seq);
        $this->assertNull(Op::where('op_id', $secondOpId)->sole()->server_seq);
        $this->assertSame(1, Op::whereNull('server_seq')->count());

        $recovered = $this->postJson('/api/sync/cloud-exchange');

        $recovered->assertOk()
            ->assertJsonPath('ok', true)
            ->assertJsonPath('pushed', 1)
            ->assertJsonPath('error', null);
        $this->assertSame(0, Op::whereNull('server_seq')->count());

        $state = SyncState::current();
        $this->assertNotNull($state->last_sync_attempt_at);
        $this->assertNotNull($state->last_sync_success_at);
        $this->assertNull($state->last_sync_error);
    }

    public function test_invalid_acknowledgement_entries_are_rejected_without_losing_valid_progress(): void
    {
        $this->pairedState();
        $firstOpId = $this->queueLocalNodeOp('first');
        $secondOpId = $this->queueLocalNodeOp('second');

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response(['accepted' => [
                ['op_id' => $firstOpId, 'server_seq' => 1],
                ['op_id' => $firstOpId, 'server_seq' => 2],
                ['op_id' => fake()->uuid(), 'server_seq' => 3],
                ['op_id' => $secondOpId, 'server_seq' => '4'],
                'not-an-acknowledgement',
            ]]),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 1]),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk()
            ->assertJsonPath('ok', false)
            ->assertJsonPath('pushed', 1);
        $this->assertStringContainsString('invalid acknowledgement entries', $response->json('error'));
        $this->assertSame(1, Op::where('op_id', $firstOpId)->sole()->server_seq);
        $this->assertNull(Op::where('op_id', $secondOpId)->sole()->server_seq);
    }

    public function test_connection_failures_are_sanitized_and_recorded(): void
    {
        $this->pairedState();
        $this->queueLocalNodeOp();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::failedConnection('sensitive connection detail'),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 0]),
        ]);

        $connectionFailure = $this->postJson('/api/sync/cloud-exchange');

        $connectionFailure->assertOk()
            ->assertJsonPath('error', 'Cloud push failed: could not connect to the cloud server.');
        $this->assertStringNotContainsString('sensitive', SyncState::current()->last_sync_error);
    }

    public function test_http_failures_are_sanitized_and_recorded(): void
    {
        $this->pairedState();
        $this->queueLocalNodeOp();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response([
                'message' => 'secret response body',
            ], 401),
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 0]),
        ]);

        $httpFailure = $this->postJson('/api/sync/cloud-exchange');

        $httpFailure->assertOk()
            ->assertJsonPath('error', 'Cloud push failed (HTTP 401).');
        $this->assertStringNotContainsString('secret response body', SyncState::current()->last_sync_error);
    }

    public function test_pull_failure_is_reported_after_a_successful_push(): void
    {
        $this->pairedState();
        $opId = $this->queueLocalNodeOp();

        Http::fake([
            self::CLOUD.'/api/sync/push' => Http::response([
                'accepted' => [['op_id' => $opId, 'server_seq' => 1]],
            ]),
            self::CLOUD.'/api/sync/pull*' => Http::response([
                'message' => 'internal cloud detail',
            ], 503),
        ]);

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk()
            ->assertJsonPath('ok', false)
            ->assertJsonPath('pushed', 1)
            ->assertJsonPath('pulled', 0)
            ->assertJsonPath('error', 'Cloud pull failed (HTTP 503).');
        $this->assertSame(1, Op::where('op_id', $opId)->sole()->server_seq);
        $this->assertStringNotContainsString('internal cloud detail', SyncState::current()->last_sync_error);
    }

    public function test_successful_exchange_records_exact_health_timestamps(): void
    {
        $state = $this->pairedState();
        $frozenAt = $this->freezeSecond();

        Http::fake([
            self::CLOUD.'/api/sync/pull*' => Http::response(['ops' => [], 'latest_seq' => 0]),
        ]);

        $this->postJson('/api/sync/cloud-exchange')
            ->assertOk()
            ->assertJsonPath('ok', true);

        $state->refresh();
        $this->assertTrue($state->last_sync_attempt_at->equalTo($frozenAt));
        $this->assertTrue($state->last_sync_success_at->equalTo($frozenAt));
        $this->assertNull($state->last_sync_error);

        $this->getJson('/api/cloud/status')
            ->assertOk()
            ->assertJsonPath('health', 'healthy')
            ->assertJsonPath('last_sync_attempt_at', $frozenAt->toIso8601String())
            ->assertJsonPath('last_sync_success_at', $frozenAt->toIso8601String());
    }

    public function test_cloud_status_reports_health_without_exposing_the_token(): void
    {
        $unconfigured = $this->getJson('/api/cloud/status');

        $unconfigured->assertOk()
            ->assertJsonPath('configured', false)
            ->assertJsonPath('health', 'unconfigured');

        $state = $this->pairedState();

        $neverSynced = $this->getJson('/api/cloud/status');
        $neverSynced->assertOk()
            ->assertJsonPath('health', 'never_synced')
            ->assertJsonPath('last_sync_attempt_at', null)
            ->assertJsonPath('last_sync_success_at', null)
            ->assertJsonPath('last_sync_error', null);
        $this->assertArrayNotHasKey('cloud_token', $neverSynced->json());

        $state->update([
            'last_sync_attempt_at' => now()->subMinute(),
            'last_sync_error' => 'Cloud push failed.',
        ]);

        $this->getJson('/api/cloud/status')
            ->assertOk()
            ->assertJsonPath('health', 'error')
            ->assertJsonPath('last_sync_error', 'Cloud push failed.');

        $state->update([
            'last_sync_success_at' => now(),
            'last_sync_error' => null,
        ]);

        $this->getJson('/api/cloud/status')
            ->assertOk()
            ->assertJsonPath('health', 'healthy');
    }

    public function test_exchange_drains_multiple_full_batches_and_reports_acknowledged_count(): void
    {
        $this->pairedState();
        $ops = [];

        for ($i = 0; $i < 201; $i++) {
            $nodeId = fake()->uuid();
            $ops[] = [
                'op_id' => fake()->uuid(),
                'client_id' => 'win',
                'hlc' => HlcGenerator::encode(100, $i, 'win'),
                'type' => 'node.set',
                'payload' => [
                    'v' => 1,
                    'id' => $nodeId,
                    'page_id' => $nodeId,
                    'fields' => ['content' => "node {$i}"],
                ],
            ];
        }

        $this->postJson('/api/sync/push', ['client_id' => 'win', 'ops' => $ops])->assertOk();

        $nextServerSeq = 1;
        $pushRequests = 0;

        Http::fake(function ($request) use (&$nextServerSeq, &$pushRequests) {
            if (str_ends_with($request->url(), '/api/sync/push')) {
                $pushRequests++;
                $accepted = [];

                foreach ($request['ops'] as $op) {
                    $accepted[] = [
                        'op_id' => $op['op_id'],
                        'server_seq' => $nextServerSeq++,
                    ];
                }

                return Http::response(['accepted' => $accepted]);
            }

            return Http::response(['ops' => [], 'latest_seq' => $nextServerSeq - 1]);
        });

        $response = $this->postJson('/api/sync/cloud-exchange');

        $response->assertOk()
            ->assertJsonPath('ok', true)
            ->assertJsonPath('pushed', 201);
        $this->assertSame(2, $pushRequests);
        $this->assertSame(0, Op::whereNull('server_seq')->count());
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

        Http::fake(function ($request) {
            if (str_ends_with($request->url(), '/api/sync/status')) {
                return Http::response(['workspace_id' => 'w', 'latest_seq' => 0]);
            }

            if (str_ends_with($request->url(), '/api/sync/push')) {
                return Http::response(['accepted' => collect($request['ops'])
                    ->values()
                    ->map(fn ($op, $index) => [
                        'op_id' => $op['op_id'],
                        'server_seq' => $index + 1,
                    ])->all()]);
            }

            return Http::response(['ops' => [], 'latest_seq' => 1]);
        });

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

    public function test_interrupted_initial_seed_retries_with_stable_operation_ids(): void
    {
        for ($i = 0; $i < 201; $i++) {
            $node = new Node;
            $node->id = fake()->uuid();
            $node->content = "Node {$i}";
            $node->position = 'a0';
            $node->save();
        }

        $pushRequests = 0;
        $firstBatchIds = [];
        $retryBatchIds = [];
        $nextServerSeq = 1;
        $recovering = false;

        Http::fake(function ($request) use (
            &$pushRequests,
            &$firstBatchIds,
            &$retryBatchIds,
            &$nextServerSeq,
            &$recovering,
        ) {
            if (str_ends_with($request->url(), '/api/sync/status')) {
                return Http::response(['workspace_id' => 'w', 'latest_seq' => 0]);
            }

            if (str_ends_with($request->url(), '/api/sync/push')) {
                if ($recovering) {
                    if ($retryBatchIds === []) {
                        $retryBatchIds = collect($request['ops'])->pluck('op_id')->all();
                    }

                    return Http::response(['accepted' => collect($request['ops'])
                        ->map(function ($op) use (&$nextServerSeq) {
                            return [
                                'op_id' => $op['op_id'],
                                'server_seq' => $nextServerSeq++,
                            ];
                        })->all()]);
                }

                $pushRequests++;

                if ($pushRequests === 1) {
                    $firstBatchIds = collect($request['ops'])->pluck('op_id')->all();

                    return Http::response(['accepted' => collect($request['ops'])
                        ->values()
                        ->map(fn ($op, $index) => [
                            'op_id' => $op['op_id'],
                            'server_seq' => $index + 1,
                        ])->all()]);
                }

                return Http::response([], 503);
            }

            return Http::response(['ops' => [], 'latest_seq' => $nextServerSeq - 1]);
        });

        $this->postJson('/api/cloud/connect', [
            'url' => self::CLOUD,
            'token' => 'test-token',
        ])->assertStatus(422)
            ->assertJsonPath('message', 'Cloud seed failed (HTTP 503).');

        $state = SyncState::current();
        $this->assertTrue($state->cloud_seed_pending);
        $this->assertSame('w', $state->cloud_workspace_id);
        $this->assertSame('Cloud seed failed (HTTP 503).', $state->last_sync_error);

        $recovering = true;

        $this->postJson('/api/sync/cloud-exchange')
            ->assertOk()
            ->assertJsonPath('ok', true);

        $this->assertSame($firstBatchIds, $retryBatchIds);
        $this->assertFalse($state->refresh()->cloud_seed_pending);
        $this->assertNull($state->last_sync_error);
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
