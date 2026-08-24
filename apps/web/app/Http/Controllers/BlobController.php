<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;

class BlobController extends Controller
{
    public function exists(Request $request, Workspace $workspace, string $hash): Response
    {
        $this->authorizeWorkspace($request, $workspace);

        if (! Storage::disk('s3')->exists($this->path($workspace, $hash))) {
            abort(404);
        }

        return response()->noContent();
    }

    public function uploadUrl(Request $request, Workspace $workspace, string $hash): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        $validated = $request->validate([
            'mime_type' => ['required', 'string', 'max:255'],
            'size' => ['required', 'integer', 'min:1'],
        ]);
        $path = $this->path($workspace, $hash);

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

    public function downloadUrl(Request $request, Workspace $workspace, string $hash): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);
        $path = $this->path($workspace, $hash);

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

    private function path(Workspace $workspace, string $hash): string
    {
        return "blobs/{$workspace->id}/{$hash}";
    }

    private function authorizeWorkspace(Request $request, Workspace $workspace): void
    {
        abort_unless($workspace->user_id === $request->user()->id, 404);
    }
}
