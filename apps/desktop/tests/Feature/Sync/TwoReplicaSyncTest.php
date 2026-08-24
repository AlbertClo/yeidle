<?php

namespace Tests\Feature\Sync;

use App\Models\Media;
use App\Sync\CloudBlobService;
use App\Sync\HlcGenerator;
use Illuminate\Support\Str;
use Tests\Support\TwoReplicaHarness;
use Tests\TestCase;

class TwoReplicaSyncTest extends TestCase
{
    private TwoReplicaHarness $replicas;

    protected function setUp(): void
    {
        parent::setUp();

        $this->replicas = new TwoReplicaHarness;
    }

    protected function tearDown(): void
    {
        $this->replicas->close();

        parent::tearDown();
    }

    public function test_an_offline_replica_catches_up_and_converges(): void
    {
        $page = (string) Str::uuid7();
        $child = (string) Str::uuid7();

        $this->replicas->push(TwoReplicaHarness::A, [
            $this->setOp($page, $page, ['content' => 'Offline page'], 100, 'a'),
        ]);
        $this->assertTrue($this->replicas->exchange(TwoReplicaHarness::A)['ok']);

        // Replica B misses the broadcast while disconnected. A later durable
        // exchange must reconstruct the same projection from the relay log.
        $this->replicas->push(TwoReplicaHarness::A, [
            $this->setOp($child, $page, [
                'parent_id' => $page,
                'position' => 'a0',
                'content' => 'written while B was offline',
            ], 200, 'a'),
        ]);
        $this->assertTrue($this->replicas->exchange(TwoReplicaHarness::A)['ok']);
        $this->assertNull($this->replicas->node(TwoReplicaHarness::B, $child));

        $result = $this->replicas->exchange(TwoReplicaHarness::B);

        $this->assertTrue($result['ok']);
        $this->assertSame(2, $result['pulled']);
        $this->assertSame(
            $this->replicas->node(TwoReplicaHarness::A, $page),
            $this->replicas->node(TwoReplicaHarness::B, $page),
        );
        $this->assertSame(
            $this->replicas->node(TwoReplicaHarness::A, $child),
            $this->replicas->node(TwoReplicaHarness::B, $child),
        );
        $this->assertSame(2, $this->replicas->cursor(TwoReplicaHarness::B));
    }

    public function test_realtime_delivery_is_idempotent(): void
    {
        $page = (string) Str::uuid7();
        $this->replicas->push(TwoReplicaHarness::A, [
            $this->setOp($page, $page, ['content' => 'Realtime page'], 100, 'a'),
        ]);
        $this->replicas->exchange(TwoReplicaHarness::A);

        $first = $this->replicas->deliverBroadcast(TwoReplicaHarness::B, 0);
        $duplicate = $this->replicas->deliverBroadcast(TwoReplicaHarness::B, 0);

        $this->assertSame([
            'applied' => 1,
            'needs_pull' => false,
            'ignored' => false,
        ], $first);
        $this->assertSame([
            'applied' => 0,
            'needs_pull' => false,
            'ignored' => true,
        ], $duplicate);
        $this->assertSame('Realtime page', $this->replicas->node(TwoReplicaHarness::B, $page)['content']);
        $this->assertSame(1, $this->replicas->cursor(TwoReplicaHarness::B));
    }

    public function test_a_realtime_sequence_gap_recovers_through_durable_pull(): void
    {
        $page = (string) Str::uuid7();
        $this->replicas->push(TwoReplicaHarness::A, [
            $this->setOp($page, $page, ['content' => 'first'], 100, 'a'),
        ]);
        $this->replicas->exchange(TwoReplicaHarness::A);

        $this->replicas->push(TwoReplicaHarness::A, [
            $this->setOp($page, $page, ['content' => 'second'], 200, 'a'),
        ]);
        $this->replicas->exchange(TwoReplicaHarness::A);

        // Deliver only the second broadcast to a cursor at zero.
        $gap = $this->replicas->deliverBroadcast(TwoReplicaHarness::B, 1);

        $this->assertTrue($gap['needs_pull']);
        $this->assertNull($this->replicas->node(TwoReplicaHarness::B, $page));
        $this->assertSame(0, $this->replicas->cursor(TwoReplicaHarness::B));

        $recovered = $this->replicas->exchange(TwoReplicaHarness::B);

        $this->assertTrue($recovered['ok']);
        $this->assertSame(2, $recovered['pulled']);
        $this->assertSame('second', $this->replicas->node(TwoReplicaHarness::B, $page)['content']);
        $this->assertSame(2, $this->replicas->cursor(TwoReplicaHarness::B));
    }

    public function test_equal_sibling_positions_have_the_same_order_on_every_replica(): void
    {
        $page = '00000000-0000-7000-8000-000000000010';
        $low = '00000000-0000-7000-8000-000000000012';
        $high = '00000000-0000-7000-8000-000000000013';
        $pageOp = $this->setOp($page, $page, ['content' => 'Page'], 100, 'a');
        $lowOp = $this->setOp($low, $page, [
            'parent_id' => $page,
            'position' => 'a0',
            'content' => 'Low ID',
        ], 200, 'a');
        $highOp = $this->setOp($high, $page, [
            'parent_id' => $page,
            'position' => 'a0',
            'content' => 'High ID',
        ], 300, 'a');

        $this->replicas->push(TwoReplicaHarness::A, [$pageOp, $highOp, $lowOp]);
        $this->replicas->push(TwoReplicaHarness::B, [$pageOp, $lowOp, $highOp]);

        $expected = [$low, $high];
        $this->assertSame($expected, $this->replicas->childIds(TwoReplicaHarness::A, $page));
        $this->assertSame($expected, $this->replicas->childIds(TwoReplicaHarness::B, $page));
    }

    public function test_media_metadata_and_blob_cache_are_isolated_per_replica(): void
    {
        $contents = 'replicated media body';
        $hash = hash('sha256', $contents);
        $mediaId = (string) Str::uuid7();
        $this->replicas->storeCloudBlob($hash, $contents);

        $this->replicas->push(TwoReplicaHarness::A, [[
            'op_id' => (string) Str::uuid7(),
            'client_id' => 'window-a',
            'hlc' => HlcGenerator::encode(100, 0, 'a'),
            'type' => 'media.create',
            'payload' => [
                'v' => 1,
                'id' => $mediaId,
                'hash' => $hash,
                'original_name' => 'photo.jpg',
                'mime_type' => 'image/jpeg',
                'size' => strlen($contents),
            ],
        ]]);
        $this->replicas->exchange(TwoReplicaHarness::A);
        $this->replicas->exchange(TwoReplicaHarness::B);

        $this->assertSame(
            $this->replicas->media(TwoReplicaHarness::A, $mediaId),
            $this->replicas->media(TwoReplicaHarness::B, $mediaId),
        );
        $this->assertFalse($this->replicas->hasLocalBlob(TwoReplicaHarness::A, $hash));
        $this->assertFalse($this->replicas->hasLocalBlob(TwoReplicaHarness::B, $hash));

        $this->replicas->on(TwoReplicaHarness::B, function () use ($mediaId, $contents): void {
            $path = app(CloudBlobService::class)->localPath(Media::findOrFail($mediaId));

            $this->assertSame($contents, file_get_contents($path));
        });

        $this->assertFalse($this->replicas->hasLocalBlob(TwoReplicaHarness::A, $hash));
        $this->assertTrue($this->replicas->hasLocalBlob(TwoReplicaHarness::B, $hash));
    }

    private function setOp(
        string $id,
        string $pageId,
        array $fields,
        int $millis,
        string $client,
    ): array {
        return [
            'op_id' => (string) Str::uuid7(),
            'client_id' => "window-{$client}",
            'hlc' => HlcGenerator::encode($millis, 0, $client),
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $pageId,
                'fields' => $fields,
            ],
        ];
    }
}
