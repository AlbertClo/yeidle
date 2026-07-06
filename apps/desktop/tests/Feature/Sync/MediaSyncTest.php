<?php

namespace Tests\Feature\Sync;

use App\Models\Media;
use App\Models\Op;
use App\Sync\HlcGenerator;
use App\Sync\OpApplier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class MediaSyncTest extends TestCase
{
    use RefreshDatabase;

    private function mediaOp(array $payload, int $millis = 100): array
    {
        return [
            'op_id' => fake()->uuid(),
            'client_id' => 'c1',
            'hlc' => HlcGenerator::encode($millis, 0, 'c1'),
            'type' => 'media.create',
            'payload' => $payload,
        ];
    }

    public function test_media_create_op_creates_the_row(): void
    {
        $id = fake()->uuid();
        (new OpApplier)->apply($this->mediaOp([
            'v' => 1,
            'id' => $id,
            'hash' => str_repeat('ab', 32),
            'original_name' => 'photo.jpg',
            'mime_type' => 'image/jpeg',
            'size' => 1234,
        ]));

        $media = Media::find($id);
        $this->assertNotNull($media);
        $this->assertSame(str_repeat('ab', 32), $media->filename);
        $this->assertSame('photo.jpg', $media->original_name);
    }

    public function test_media_create_is_idempotent(): void
    {
        $id = fake()->uuid();
        $op = $this->mediaOp([
            'v' => 1,
            'id' => $id,
            'hash' => str_repeat('cd', 32),
            'original_name' => 'a.png',
            'mime_type' => 'image/png',
            'size' => 10,
        ]);

        $applier = new OpApplier;
        $applier->apply($op);
        $applier->apply($op);

        $this->assertSame(1, Media::count());
    }

    public function test_malformed_media_op_is_dropped_not_fatal(): void
    {
        (new OpApplier)->apply($this->mediaOp(['v' => 1, 'id' => fake()->uuid()]));

        $this->assertSame(0, Media::count());
    }

    public function test_media_create_is_accepted_by_the_push_endpoint(): void
    {
        $op = $this->mediaOp([
            'v' => 1,
            'id' => fake()->uuid(),
            'hash' => str_repeat('ef', 32),
            'original_name' => 'doc.pdf',
            'mime_type' => 'application/pdf',
            'size' => 999,
        ]);

        $this->postJson('/api/sync/push', ['client_id' => 'c1', 'ops' => [$op]])
            ->assertOk();

        $this->assertSame(1, Media::count());
        $this->assertSame(1, Op::count());
    }

    public function test_chunked_upload_mints_a_media_create_op(): void
    {
        Storage::fake('local');

        $uploadId = $this->postJson('/api/media/init', [
            'filename' => 'test.bin',
            'size' => 6,
            'mime_type' => 'application/octet-stream',
            'total_chunks' => 1,
        ])->assertStatus(201)->json('upload_id');

        $this->post('/api/media/chunk', [
            'upload_id' => $uploadId,
            'chunk_index' => 0,
            'chunk' => UploadedFile::fake()->createWithContent('chunk_0', 'abcdef'),
        ])->assertOk();

        $response = $this->postJson('/api/media/complete', ['upload_id' => $uploadId]);
        $response->assertStatus(201);

        $expectedHash = hash('sha256', 'abcdef');
        $this->assertSame($expectedHash, $response->json('filename'));

        $op = Op::sole();
        $this->assertSame('media.create', $op->type);
        $this->assertSame($expectedHash, $op->payload['hash']);
        $this->assertSame('test.bin', $op->payload['original_name']);
        $this->assertSame($response->json('id'), $op->payload['id']);
        $this->assertStringStartsWith('srv-', $op->client_id);

        Storage::disk('local')->assertExists("media/{$expectedHash}");
    }
}
