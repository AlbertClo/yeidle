<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\SyncState;
use GuzzleHttp\Psr7\Utils;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Storage;

class CloudBlobService
{
    private const TRANSFER_TIMEOUT = 600;

    /**
     * Upload local blobs that have not yet been confirmed in cloud storage.
     * The timestamp is durable retry state; duplicate media rows sharing a
     * content hash are acknowledged together.
     */
    public function uploadPending(SyncState $state): int
    {
        $uploaded = 0;
        $disk = Storage::disk('local');

        foreach (Media::query()->whereNull('cloud_uploaded_at')->get() as $media) {
            $relativePath = "media/{$media->filename}";

            if (! $disk->exists($relativePath)) {
                continue;
            }

            $exists = $this->cloud($state)
                ->head("{$state->cloud_url}/api/blobs/{$media->filename}");

            if ($exists->successful()) {
                $this->markUploaded($media->filename);

                continue;
            }

            if (! $exists->notFound()) {
                $exists->throw();
            }

            $ticket = $this->cloud($state)
                ->post("{$state->cloud_url}/api/blobs/{$media->filename}/upload-url", [
                    'mime_type' => $media->mime_type,
                    'size' => $media->size,
                ])
                ->throw();

            if ($ticket->json('exists') === true) {
                $this->markUploaded($media->filename);

                continue;
            }

            $url = $ticket->json('url');
            $headers = $ticket->json('headers');

            if (! is_string($url) || $url === '' || ! is_array($headers)) {
                throw new CloudSyncProtocolException(
                    'Cloud blob upload protocol error: expected a presigned URL and headers.'
                );
            }

            $stream = $disk->readStream($relativePath);

            if (! is_resource($stream)) {
                throw new \RuntimeException("Unable to read local blob [{$media->filename}].");
            }

            $body = Utils::streamFor($stream);

            try {
                Http::withHeaders($headers)
                    ->withBody($body, $media->mime_type)
                    ->timeout(self::TRANSFER_TIMEOUT)
                    ->put($url)
                    ->throw();
            } finally {
                $body->close();
            }

            $this->markUploaded($media->filename);
            $uploaded++;
        }

        return $uploaded;
    }

    /**
     * Return a local blob path, downloading and hash-verifying a cache miss.
     */
    public function localPath(Media $media): string
    {
        $disk = Storage::disk('local');
        $relativePath = "media/{$media->filename}";

        if ($disk->exists($relativePath)) {
            return $disk->path($relativePath);
        }

        $state = SyncState::current();

        if ($state === null || ! $state->cloud_url) {
            throw new \RuntimeException('The media blob is not available locally or in a configured cloud.');
        }

        $ticket = $this->cloud($state)
            ->get("{$state->cloud_url}/api/blobs/{$media->filename}/download-url")
            ->throw();
        $url = $ticket->json('url');

        if (! is_string($url) || $url === '') {
            throw new CloudSyncProtocolException(
                'Cloud blob download protocol error: expected a presigned URL.'
            );
        }

        $disk->makeDirectory('media');
        $temporary = "media/.{$media->filename}.".bin2hex(random_bytes(8)).'.tmp';
        $temporaryPath = $disk->path($temporary);

        try {
            Http::timeout(self::TRANSFER_TIMEOUT)
                ->sink($temporaryPath)
                ->get($url)
                ->throw();

            $actualHash = hash_file('sha256', $temporaryPath);

            if (! is_string($actualHash) || ! hash_equals($media->filename, $actualHash)) {
                throw new CloudSyncProtocolException(
                    'Cloud blob download failed integrity verification.'
                );
            }

            $finalPath = $disk->path($relativePath);

            if (file_exists($finalPath)) {
                $disk->delete($temporary);
            } elseif (! rename($temporaryPath, $finalPath)) {
                throw new \RuntimeException('Unable to store the downloaded media blob.');
            }

            $this->markUploaded($media->filename);

            return $finalPath;
        } catch (\Throwable $exception) {
            $disk->delete($temporary);

            throw $exception;
        }
    }

    private function cloud(SyncState $state): PendingRequest
    {
        return Http::withToken($state->cloud_token)->acceptJson()
            ->connectTimeout(5)->timeout(30);
    }

    private function markUploaded(string $hash): void
    {
        Media::query()->where('filename', $hash)->update([
            'cloud_uploaded_at' => now(),
        ]);
    }
}
