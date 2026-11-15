<?php

namespace App\Http\Controllers;

use App\Models\Workspace;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Filesystem\FilesystemAdapter;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Storage;

class BlobController extends Controller
{
    public function exists(Request $request, Workspace $workspace, string $hash): Response
    {
        $this->authorizeWorkspace($request, $workspace);

        if (! $this->disk()->exists($this->path($workspace, $hash))) {
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

        if ($this->disk()->exists($path)) {
            return response()->json(['exists' => true]);
        }

        $upload = $this->publicDisk()->temporaryUploadUrl(
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

        if (! $this->disk()->exists($path)) {
            abort(404);
        }

        return response()->json([
            'url' => $this->publicDisk()->temporaryUrl(
                $path,
                now()->addMinutes(10),
            ),
        ]);
    }

    /**
     * The disk the app checks blobs on.
     */
    private function disk(): FilesystemAdapter
    {
        return Storage::disk(config('filesystems.blobs.disk'));
    }

    /**
     * The disk that signs the URLs devices transfer blobs with.
     */
    private function publicDisk(): FilesystemAdapter
    {
        return Storage::disk(config('filesystems.blobs.public_disk'));
    }

    private function path(Workspace $workspace, string $hash): string
    {
        return "blobs/{$workspace->id}/{$hash}";
    }

    private function authorizeWorkspace(Request $request, Workspace $workspace): void
    {
        abort_unless(
            $request->user()->workspaces()->whereKey($workspace->id)->exists(),
            404,
        );
    }
}
