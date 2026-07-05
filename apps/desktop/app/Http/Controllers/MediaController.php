<?php

namespace App\Http\Controllers;

use App\Models\Media;
use App\Support\Shell;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpFoundation\StreamedResponse;

class MediaController extends Controller
{
    public function initUpload(Request $request): JsonResponse
    {
        $request->validate([
            'filename' => ['required', 'string'],
            'size' => ['required', 'integer', 'min:1'],
            'mime_type' => ['required', 'string'],
            'total_chunks' => ['required', 'integer', 'min:1'],
        ]);

        $uploadId = Str::uuid()->toString();
        Storage::disk('local')->makeDirectory("uploads/{$uploadId}");

        // Store upload metadata
        Storage::disk('local')->put("uploads/{$uploadId}/meta.json", json_encode([
            'filename' => $request->filename,
            'size' => $request->size,
            'mime_type' => $request->mime_type,
            'total_chunks' => $request->total_chunks,
            'received_chunks' => 0,
        ]));

        return response()->json(['upload_id' => $uploadId], 201);
    }

    public function uploadChunk(Request $request): JsonResponse
    {
        $request->validate([
            'upload_id' => ['required', 'string'],
            'chunk_index' => ['required', 'integer', 'min:0'],
            'chunk' => ['required', 'file'],
        ]);

        $uploadId = $request->upload_id;
        $metaPath = "uploads/{$uploadId}/meta.json";

        if (! Storage::disk('local')->exists($metaPath)) {
            return response()->json(['message' => 'Upload not found'], 404);
        }

        $request->file('chunk')->storeAs(
            "uploads/{$uploadId}",
            "chunk_{$request->chunk_index}",
            'local'
        );

        // Update received count
        $meta = json_decode(Storage::disk('local')->get($metaPath), true);
        $meta['received_chunks']++;
        Storage::disk('local')->put($metaPath, json_encode($meta));

        return response()->json(['received' => $meta['received_chunks']], 200);
    }

    public function completeUpload(Request $request): JsonResponse
    {
        $request->validate([
            'upload_id' => ['required', 'string'],
        ]);

        $uploadId = $request->upload_id;
        $metaPath = "uploads/{$uploadId}/meta.json";

        if (! Storage::disk('local')->exists($metaPath)) {
            return response()->json(['message' => 'Upload not found'], 404);
        }

        $meta = json_decode(Storage::disk('local')->get($metaPath), true);
        $disk = Storage::disk('local');

        // Assemble chunks, hashing the content as it streams
        $disk->makeDirectory('media');
        $tmpPath = $disk->path("uploads/{$uploadId}/assembled");
        $context = hash_init('sha256');

        $out = fopen($tmpPath, 'wb');
        for ($i = 0; $i < $meta['total_chunks']; $i++) {
            $chunkPath = $disk->path("uploads/{$uploadId}/chunk_{$i}");
            $in = fopen($chunkPath, 'rb');
            while (! feof($in)) {
                $buffer = fread($in, 1024 * 1024);
                hash_update($context, $buffer);
                fwrite($out, $buffer);
            }
            fclose($in);
        }
        fclose($out);
        $hash = hash_final($context);

        // Content-addressed storage: the blob is named by its hash, so
        // re-uploading identical content reuses the existing file
        $finalPath = $disk->path("media/{$hash}");
        if (file_exists($finalPath)) {
            unlink($tmpPath);
        } else {
            rename($tmpPath, $finalPath);
        }

        // Create media record
        $media = Media::create([
            'original_name' => $meta['filename'],
            'filename' => $hash,
            'mime_type' => $meta['mime_type'],
            'size' => $meta['size'],
        ]);

        // Clean up chunks
        $disk->deleteDirectory("uploads/{$uploadId}");

        return response()->json($media, 201);
    }

    public function show(Media $media): StreamedResponse
    {
        $path = Storage::disk('local')->path("media/{$media->filename}");

        return response()->stream(function () use ($path) {
            readfile($path);
        }, 200, [
            'Content-Type' => $media->mime_type,
            'Content-Disposition' => "inline; filename=\"{$media->original_name}\"",
            'Cache-Control' => 'public, max-age=31536000',
        ]);
    }

    public function open(Media $media): JsonResponse
    {
        $disk = Storage::disk('local');
        $blob = $disk->path("media/{$media->filename}");

        // Blobs are extension-less content hashes; hardlink to the original
        // filename so the OS can pick the right application
        $disk->makeDirectory('media-open');
        $target = $disk->path("media-open/{$media->id}-".basename($media->original_name));

        if (! file_exists($target) && ! @link($blob, $target)) {
            copy($blob, $target);
        }

        Shell::open($target);

        return response()->json(null, 200);
    }

    public function openFolder(Media $media): JsonResponse
    {
        $dir = Storage::disk('local')->path('media');
        Shell::open($dir);

        return response()->json(null, 200);
    }
}
