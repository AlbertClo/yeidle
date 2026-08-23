<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;

class BlobController extends Controller
{
    public function exists(Request $request, string $hash): Response
    {
        if (! Storage::disk('s3')->exists($this->path($request, $hash))) {
            abort(404);
        }

        return response()->noContent();
    }

    public function uploadUrl(Request $request, string $hash): JsonResponse
    {
        $validated = $request->validate([
            'mime_type' => ['required', 'string', 'max:255'],
            'size' => ['required', 'integer', 'min:1'],
        ]);
        $path = $this->path($request, $hash);

        if (Storage::disk('s3')->exists($path)) {
            return response()->json(['exists' => true]);
        }

        $upload = Storage::disk('s3_public')->temporaryUploadUrl(
            $path,
            now()->addMinutes(10),
            [
                'ContentType' => $validated['mime_type'],
                'ContentLength' => $validated['size'],
                'ChecksumSHA256' => base64_encode(pack('H*', $hash)),
            ],
        );

        return response()->json([
            'exists' => false,
            'url' => $upload['url'],
            'headers' => $upload['headers'],
        ]);
    }

    public function downloadUrl(Request $request, string $hash): JsonResponse
    {
        $path = $this->path($request, $hash);

        if (! Storage::disk('s3')->exists($path)) {
            abort(404);
        }

        return response()->json([
            'url' => Storage::disk('s3_public')->temporaryUrl(
                $path,
                now()->addMinutes(10),
            ),
        ]);
    }

    private function path(Request $request, string $hash): string
    {
        return "blobs/{$this->workspaceFor($request)->id}/{$hash}";
    }

    private function workspaceFor(Request $request): Workspace
    {
        return $request->user()->workspaces()->firstOrCreate([], [
            'name' => 'Personal',
        ]);
    }
}
