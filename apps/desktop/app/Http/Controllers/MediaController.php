<?php

namespace App\Http\Controllers;

use App\Models\Media;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Storage;
use Symfony\Component\HttpFoundation\StreamedResponse;

class MediaController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $request->validate([
            'file' => ['required', 'file', 'max:102400'], // 100MB max
        ]);

        $file = $request->file('file');
        $media = Media::create([
            'original_name' => $file->getClientOriginalName(),
            'filename' => $file->hashName(),
            'mime_type' => $file->getMimeType(),
            'size' => $file->getSize(),
        ]);

        $file->storeAs('media', $media->filename, 'local');

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
        \Native\Desktop\Facades\Shell::openFile($path);

        return response()->json(null, 200);
    }

    public function openFolder(Media $media): JsonResponse
    {
        $dir = Storage::disk('local')->path('media');
        \Native\Desktop\Facades\Shell::openExternal("file://{$dir}");

        return response()->json(null, 200);
    }
}
