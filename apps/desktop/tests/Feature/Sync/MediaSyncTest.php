<?php

namespace Tests\Feature\Sync;

use App\Models\Media;
use App\Models\Op;
use App\Models\SyncState;
use App\Sync\CloudBlobService;
use App\Sync\HlcGenerator;
use App\Sync\OpApplier;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Http;
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

    public function test_media_op_with_a_non_canonical_hash_is_dropped(): void
    {
        (new OpApplier)->apply($this->mediaOp([
            'v' => 1,
            'id' => fake()->uuid(),
            'hash' => '../../not-a-blob',
            'original_name' => 'unsafe.bin',
            'mime_type' => 'application/octet-stream',
            'size' => 10,
        ]));

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

    public function test_pending_local_blob_uploads_through_a_presigned_url(): void
    {
        Storage::fake('local');
        $state = $this->pairedState();
        $contents = 'upload me';
        $hash = hash('sha256', $contents);
        $media = Media::create([
            'filename' => $hash,
            'original_name' => 'upload.txt',
            'mime_type' => 'text/plain',
            'size' => strlen($contents),
        ]);
        Storage::disk('local')->put("media/{$hash}", $contents);
        $blobUrl = "https://cloud.test/api/workspaces/{$state->cloud_workspace_id}/blobs/{$hash}";

        Http::fake([
            $blobUrl => Http::response(status: 404),
            $blobUrl.'/upload-url' => Http::response([
                'exists' => false,
                'url' => 'https://objects.test/upload',
                'headers' => ['Content-Type' => 'text/plain'],
            ]),
            'https://objects.test/upload' => Http::response(status: 200),
        ]);

        $uploaded = app(CloudBlobService::class)->uploadPending($state);

        $this->assertSame(1, $uploaded);
        $this->assertNotNull($media->fresh()->cloud_uploaded_at);
        Http::assertSent(fn ($request) => $request->method() === 'PUT'
            && $request->url() === 'https://objects.test/upload');
    }

    public function test_existing_cloud_blob_is_acknowledged_without_uploading_again(): void
    {
        Storage::fake('local');
        $state = $this->pairedState();
        $contents = 'already there';
        $hash = hash('sha256', $contents);
        $media = Media::create([
            'filename' => $hash,
            'original_name' => 'existing.txt',
            'mime_type' => 'text/plain',
            'size' => strlen($contents),
        ]);
        Storage::disk('local')->put("media/{$hash}", $contents);
        $blobUrl = "https://cloud.test/api/workspaces/{$state->cloud_workspace_id}/blobs/{$hash}";

        Http::fake([
            $blobUrl => Http::response(status: 204),
        ]);

        $uploaded = app(CloudBlobService::class)->uploadPending($state);

        $this->assertSame(0, $uploaded);
        $this->assertNotNull($media->fresh()->cloud_uploaded_at);
        Http::assertSentCount(1);
    }

    public function test_pending_upload_count_only_includes_local_unconfirmed_blobs(): void
    {
        Storage::fake('local');
        $pendingHash = hash('sha256', 'pending');
        $remoteHash = hash('sha256', 'remote only');
        $uploadedHash = hash('sha256', 'uploaded');

        foreach ([
            [$pendingHash, null],
            [$remoteHash, null],
            [$uploadedHash, now()],
        ] as [$hash, $uploadedAt]) {
            Media::create([
                'filename' => $hash,
                'original_name' => "{$hash}.txt",
                'mime_type' => 'text/plain',
                'size' => 1,
                'cloud_uploaded_at' => $uploadedAt,
            ]);
        }

        Storage::disk('local')->put("media/{$pendingHash}", 'pending');
        Storage::disk('local')->put("media/{$uploadedHash}", 'uploaded');
        Storage::disk('local')->put('media/.temporary-file', 'ignored');

        $this->assertSame(1, app(CloudBlobService::class)->pendingUploadCount());
    }

    public function test_media_cache_miss_downloads_and_verifies_the_cloud_blob(): void
    {
        Storage::fake('local');
        $this->pairedState();
        $contents = 'download me';
        $hash = hash('sha256', $contents);
        $media = Media::create([
            'filename' => $hash,
            'original_name' => 'download.txt',
            'mime_type' => 'text/plain',
            'size' => strlen($contents),
        ]);
        $blobUrl = 'https://cloud.test/api/workspaces/'.SyncState::current()->cloud_workspace_id."/blobs/{$hash}";

        Http::fake([
            $blobUrl.'/download-url' => Http::response([
                'url' => 'https://objects.test/download',
            ]),
            'https://objects.test/download' => Http::response($contents),
        ]);

        $response = $this->get("/api/media/{$media->id}")->assertOk();

        $this->assertSame($contents, $response->streamedContent());
        Storage::disk('local')->assertExists("media/{$hash}");
        $this->assertNotNull($media->fresh()->cloud_uploaded_at);
    }

    public function test_media_cache_miss_rejects_a_blob_with_the_wrong_hash(): void
    {
        Storage::fake('local');
        $this->pairedState();
        $hash = hash('sha256', 'expected');
        $media = Media::create([
            'filename' => $hash,
            'original_name' => 'corrupt.txt',
            'mime_type' => 'text/plain',
            'size' => 8,
        ]);
        $blobUrl = 'https://cloud.test/api/workspaces/'.SyncState::current()->cloud_workspace_id."/blobs/{$hash}";

        Http::fake([
            $blobUrl.'/download-url' => Http::response([
                'url' => 'https://objects.test/corrupt',
            ]),
            'https://objects.test/corrupt' => Http::response('wrong'),
        ]);

        $this->get("/api/media/{$media->id}")->assertStatus(503);

        Storage::disk('local')->assertMissing("media/{$hash}");
        $this->assertNull($media->fresh()->cloud_uploaded_at);
    }

    private function pairedState(): SyncState
    {
        return SyncState::create([
            'client_id' => fake()->uuid(),
            'last_server_seq' => 0,
            'cloud_url' => 'https://cloud.test',
            'cloud_token' => 'secret-token',
            'cloud_workspace_id' => fake()->uuid(),
        ]);
    }
}
