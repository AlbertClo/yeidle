<?php

use App\Models\User;
use App\Models\Workspace;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Laravel\Sanctum\Sanctum;

uses(RefreshDatabase::class);

beforeEach(function () {
    Storage::fake('s3');
    config()->set('filesystems.disks.s3_public', [
        'driver' => 's3',
        'key' => 'test-key',
        'secret' => 'test-secret',
        'region' => 'us-east-1',
        'bucket' => 'yeidle',
        'endpoint' => 'http://localhost:9000',
        'use_path_style_endpoint' => true,
        'throw' => true,
    ]);
    Storage::forgetDisk('s3_public');
});

test('blob endpoints require authentication', function () {
    $hash = str_repeat('ab', 32);

    $this->head("/api/blobs/{$hash}")->assertUnauthorized();
    $this->postJson("/api/blobs/{$hash}/upload-url", [
        'mime_type' => 'image/png',
        'size' => 10,
    ])->assertUnauthorized();
    $this->getJson("/api/blobs/{$hash}/download-url")->assertUnauthorized();
});

test('blob existence is scoped to the authenticated workspace', function () {
    $alice = User::factory()->create();
    $aliceWorkspace = Workspace::factory()->for($alice)->create();
    $bob = User::factory()->create();
    Workspace::factory()->for($bob)->create();
    $hash = str_repeat('cd', 32);

    Storage::disk('s3')->put("blobs/{$aliceWorkspace->id}/{$hash}", 'private');

    Sanctum::actingAs($alice);
    $this->head("/api/blobs/{$hash}")->assertNoContent();

    Sanctum::actingAs($bob);
    $this->head("/api/blobs/{$hash}")->assertNotFound();
});

test('it returns workspace-scoped presigned transfer urls', function () {
    $user = User::factory()->create();
    $workspace = Workspace::factory()->for($user)->create();
    $hash = str_repeat('ef', 32);
    Sanctum::actingAs($user);

    $upload = $this->postJson("/api/blobs/{$hash}/upload-url", [
        'mime_type' => 'image/png',
        'size' => 123,
    ])->assertOk()
        ->assertJsonPath('exists', false)
        ->assertJsonPath(
            'headers.x-amz-checksum-sha256.0',
            base64_encode(pack('H*', $hash)),
        )
        ->assertJsonStructure(['url', 'headers']);

    expect($upload->json('url'))
        ->toStartWith('http://localhost:9000/yeidle/')
        ->toContain("blobs/{$workspace->id}/{$hash}");

    Storage::disk('s3')->put("blobs/{$workspace->id}/{$hash}", 'blob');

    $download = $this->getJson("/api/blobs/{$hash}/download-url")
        ->assertOk()
        ->assertJsonStructure(['url']);

    expect($download->json('url'))
        ->toStartWith('http://localhost:9000/yeidle/')
        ->toContain("blobs/{$workspace->id}/{$hash}");
});

test('it does not issue another upload url for an existing blob', function () {
    $user = User::factory()->create();
    $workspace = Workspace::factory()->for($user)->create();
    $hash = str_repeat('12', 32);
    Sanctum::actingAs($user);
    Storage::disk('s3')->put("blobs/{$workspace->id}/{$hash}", 'blob');

    $this->postJson("/api/blobs/{$hash}/upload-url", [
        'mime_type' => 'application/octet-stream',
        'size' => 4,
    ])->assertOk()
        ->assertExactJson(['exists' => true]);
});

test('blob hashes must be canonical sha256 values', function () {
    Sanctum::actingAs(User::factory()->create());

    $this->head('/api/blobs/not-a-hash')->assertNotFound();
});
