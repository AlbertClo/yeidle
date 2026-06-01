<?php

namespace App\Http\Controllers;

use App\Models\Media;
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

        // Assemble chunks into final file
        $hashName = Str::random(40).'.'.pathinfo($meta['filename'], PATHINFO_EXTENSION);
        $finalPath = $disk->path("media/{$hashName}");

        // Ensure media directory exists
        $disk->makeDirectory('media');

        $out = fopen($finalPath, 'wb');
        for ($i = 0; $i < $meta['total_chunks']; $i++) {
            $chunkPath = $disk->path("uploads/{$uploadId}/chunk_{$i}");
            $in = fopen($chunkPath, 'rb');
            stream_copy_to_stream($in, $out);
            fclose($in);
        }
        fclose($out);

        // Create media record
        $media = Media::create([
            'original_name' => $meta['filename'],
            'filename' => $hashName,
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
        $path = Storage::disk('local')->path("media/{$media->filename}");
        exec('xdg-open '.escapeshellarg($path).' > /dev/null 2>&1 &');

        return response()->json(null, 200);
    }

    public function openFolder(Media $media): JsonResponse
    {
        $dir = Storage::disk('local')->path('media');
        exec('xdg-open '.escapeshellarg($dir).' > /dev/null 2>&1 &');

        return response()->json(null, 200);
    }
}
