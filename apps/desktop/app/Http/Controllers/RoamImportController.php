<?php

namespace App\Http\Controllers;

use App\Import\Roam\RoamExport;
use App\Import\Roam\RoamImportCancelled;
use App\Import\Roam\RoamImporter;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use JsonException;
use RuntimeException;
use Symfony\Component\HttpFoundation\StreamedResponse;
use Throwable;

class RoamImportController extends Controller
{
    private const CHUNK_BYTES = 1024 * 1024;

    private const MAX_EXPORT_BYTES = 512 * 1024 * 1024;

    public function __construct(
        private readonly WorkspaceIndex $workspaces,
        private readonly RoamImporter $importer,
    ) {}

    public function initialize(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'filename' => ['required', 'string', 'max:255', 'regex:/\.json$/i'],
            'size' => ['required', 'integer', 'min:2', 'max:'.self::MAX_EXPORT_BYTES],
        ]);
        $totalChunks = (int) ceil($validated['size'] / self::CHUNK_BYTES);

        $this->deleteExpiredUploads();

        $uploadId = (string) Str::uuid7();
        $directory = $this->uploadDirectory($uploadId);
        File::ensureDirectoryExists($directory, 0700);
        File::put($directory.'/meta.json', json_encode([
            'filename' => basename($validated['filename']),
            'size' => $validated['size'],
            'total_chunks' => $totalChunks,
            'created_at' => now()->toIso8601String(),
        ], JSON_THROW_ON_ERROR));

        return response()->json([
            'upload_id' => $uploadId,
            'chunk_size' => self::CHUNK_BYTES,
            'total_chunks' => $totalChunks,
        ], 201);
    }

    public function uploadChunk(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'upload_id' => ['required', 'string', 'uuid'],
            'chunk_index' => ['required', 'integer', 'min:0'],
            'chunk' => ['required', 'file', 'max:1280'],
        ]);
        $directory = $this->existingUploadDirectory($validated['upload_id']);
        $meta = $this->readMetadata($directory);
        $index = (int) $validated['chunk_index'];

        if ($index >= $meta['total_chunks']) {
            throw ValidationException::withMessages([
                'chunk_index' => 'The Roam export chunk index is invalid.',
            ]);
        }

        $expectedSize = $index === $meta['total_chunks'] - 1
            ? $meta['size'] - ($index * self::CHUNK_BYTES)
            : self::CHUNK_BYTES;
        $chunk = $request->file('chunk');

        $receivedSize = $chunk?->getSize();

        if ($receivedSize !== $expectedSize) {
            throw ValidationException::withMessages([
                'chunk' => "The Roam export chunk has an unexpected size ({$receivedSize} received; {$expectedSize} expected).",
            ]);
        }

        $chunk->move($directory, "chunk_{$index}");

        return response()->json(['received' => $index]);
    }

    public function finish(Request $request): JsonResponse
    {
        $validated = $this->validateImport($request);

        try {
            return response()->json($this->runImport($validated));
        } catch (Throwable $exception) {
            report($exception);

            return response()->json([
                'message' => $exception instanceof RuntimeException
                    ? $exception->getMessage()
                    : 'The Roam database could not be imported.',
            ], 422);
        }
    }

    public function stream(Request $request): StreamedResponse
    {
        $validated = $this->validateImport($request);

        return response()->stream(function () use ($validated): void {
            $previousIgnoreUserAbort = ignore_user_abort(true);
            $emit = function (array $event): void {
                echo json_encode($event, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)."\n";

                if (ob_get_level() > 0) {
                    @ob_flush();
                }

                flush();

                if (connection_aborted()) {
                    throw new RoamImportCancelled;
                }
            };

            try {
                $emit([
                    'type' => 'progress',
                    'phase' => 'preparing',
                    'current' => 0,
                    'total' => 0,
                ]);

                $result = $this->runImport(
                    $validated,
                    fn (string $phase, int $current, int $total) => $emit([
                        'type' => 'progress',
                        'phase' => $phase,
                        'current' => $current,
                        'total' => $total,
                    ]),
                );

                $emit(['type' => 'complete', 'result' => $result]);
            } catch (RoamImportCancelled) {
                // The client deliberately closed the stream. runImport has
                // already removed an incomplete newly-created workspace.
            } catch (Throwable $exception) {
                report($exception);

                if (! connection_aborted()) {
                    $emit([
                        'type' => 'error',
                        'message' => $exception instanceof RuntimeException
                            ? $exception->getMessage()
                            : 'The Roam database could not be imported.',
                    ]);
                }
            } finally {
                ignore_user_abort((bool) $previousIgnoreUserAbort);
            }
        }, headers: [
            'Cache-Control' => 'no-cache, no-store',
            'Content-Type' => 'application/x-ndjson',
            'X-Accel-Buffering' => 'no',
        ]);
    }

    public function cancel(string $uploadId): JsonResponse
    {
        if (Str::isUuid($uploadId)) {
            File::deleteDirectory($this->uploadDirectory($uploadId));
        }

        return response()->json(null, 204);
    }

    /**
     * @return array{upload_id: string, workspace_id: ?string, new_workspace_name: ?string, download_attachments: bool}
     */
    private function validateImport(Request $request): array
    {
        $validated = $request->validate([
            'upload_id' => ['required', 'string', 'uuid'],
            'workspace_id' => ['nullable', 'string', 'uuid'],
            'new_workspace_name' => ['nullable', 'string', 'max:100'],
            'download_attachments' => ['required', 'boolean'],
        ]);
        $workspaceId = $validated['workspace_id'] ?? null;
        $newWorkspaceName = trim((string) ($validated['new_workspace_name'] ?? ''));

        if (($workspaceId === null) === ($newWorkspaceName === '')) {
            throw ValidationException::withMessages([
                'workspace' => 'Choose an existing workspace or enter a new workspace name.',
            ]);
        }

        return [
            'upload_id' => $validated['upload_id'],
            'workspace_id' => $workspaceId,
            'new_workspace_name' => $newWorkspaceName !== '' ? $newWorkspaceName : null,
            'download_attachments' => $validated['download_attachments'],
        ];
    }

    /**
     * @param  array{upload_id: string, workspace_id: ?string, new_workspace_name: ?string, download_attachments: bool}  $validated
     * @param  null|callable(string, int, int): void  $progress
     * @return array{workspace: array, report: array<string, int>, warnings: list<string>, has_failures: bool}
     */
    private function runImport(array $validated, ?callable $progress = null): array
    {
        $directory = $this->existingUploadDirectory($validated['upload_id']);
        $workspace = null;
        $createdWorkspace = $validated['workspace_id'] === null;

        try {
            $exportPath = $this->assembleExport($directory);

            // Validate the complete export before creating a destination so a
            // malformed file cannot leave an empty workspace behind.
            RoamExport::fromPath($exportPath, 'validation');

            $workspace = $validated['workspace_id'] !== null
                ? $this->workspaces->find($validated['workspace_id'])
                : $this->workspaces->create((string) $validated['new_workspace_name']);

            $this->workspaces->configureActiveConnection($workspace['id']);

            $report = $this->importer->import(
                $exportPath,
                downloadAttachments: $validated['download_attachments'],
                workspaceId: $workspace['id'],
                progress: $progress,
            );

            return [
                'workspace' => $workspace,
                'report' => $report->summary(),
                'warnings' => $report->warnings,
                'has_failures' => $report->hasFailures(),
            ];
        } catch (RoamImportCancelled $exception) {
            if ($createdWorkspace && is_array($workspace)) {
                $this->workspaces->delete($workspace['id']);
            }

            throw $exception;
        } finally {
            File::deleteDirectory($directory);
        }
    }

    /** @return array{filename: string, size: int, total_chunks: int, created_at: string} */
    private function readMetadata(string $directory): array
    {
        try {
            $meta = json_decode(File::get($directory.'/meta.json'), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new RuntimeException('The Roam upload metadata is invalid.');
        }

        if (! is_array($meta)
            || ! is_string($meta['filename'] ?? null)
            || ! is_int($meta['size'] ?? null)
            || ! is_int($meta['total_chunks'] ?? null)
            || ! is_string($meta['created_at'] ?? null)) {
            throw new RuntimeException('The Roam upload metadata is invalid.');
        }

        /** @var array{filename: string, size: int, total_chunks: int, created_at: string} $meta */
        return $meta;
    }

    private function assembleExport(string $directory): string
    {
        $meta = $this->readMetadata($directory);
        $exportPath = $directory.'/export.json';
        $output = fopen($exportPath, 'wb');

        if ($output === false) {
            throw new RuntimeException('The uploaded Roam export could not be assembled.');
        }

        $bytesWritten = 0;

        try {
            for ($index = 0; $index < $meta['total_chunks']; $index++) {
                $chunkPath = $directory."/chunk_{$index}";

                if (! is_file($chunkPath)) {
                    throw new RuntimeException("Roam export chunk {$index} is missing.");
                }

                $input = fopen($chunkPath, 'rb');

                if ($input === false) {
                    throw new RuntimeException("Roam export chunk {$index} could not be read.");
                }

                try {
                    $copied = stream_copy_to_stream($input, $output);

                    if ($copied === false) {
                        throw new RuntimeException("Roam export chunk {$index} could not be copied.");
                    }

                    $bytesWritten += $copied;
                } finally {
                    fclose($input);
                }
            }
        } finally {
            fclose($output);
        }

        if ($bytesWritten !== $meta['size']) {
            throw new RuntimeException('The uploaded Roam export has an unexpected size.');
        }

        return $exportPath;
    }

    private function existingUploadDirectory(string $uploadId): string
    {
        $directory = $this->uploadDirectory($uploadId);

        if (! is_file($directory.'/meta.json')) {
            abort(404, 'Roam upload not found.');
        }

        return $directory;
    }

    private function uploadDirectory(string $uploadId): string
    {
        return storage_path('app/roam-imports/'.$uploadId);
    }

    private function deleteExpiredUploads(): void
    {
        $root = storage_path('app/roam-imports');

        if (! is_dir($root)) {
            return;
        }

        foreach (File::directories($root) as $directory) {
            $modifiedAt = filemtime($directory);

            if ($modifiedAt !== false && $modifiedAt < now()->subDay()->getTimestamp()) {
                File::deleteDirectory($directory);
            }
        }
    }
}
