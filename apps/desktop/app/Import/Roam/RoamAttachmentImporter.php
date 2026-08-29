<?php

namespace App\Import\Roam;

use App\Models\Media;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Support\Facades\Storage;
use RuntimeException;
use Throwable;

final class RoamAttachmentImporter
{
    public function __construct(
        private readonly RoamAttachmentFetcher $fetcher,
        private readonly SyncService $sync,
    ) {}

    /**
     * @param  list<string>  $urls
     * @param  null|callable(int, int): void  $progress
     * @return array<string, array{id: string, original_name: string, mime_type: string, size: int}>
     */
    public function import(
        array $urls,
        RoamImportReport $report,
        HlcGenerator $clock,
        string $workspaceId = 'default',
        ?callable $progress = null,
        int $maximumBytes = 1073741824,
    ): array {
        $mediaByUrl = [];
        $disk = Storage::disk('local');
        $disk->makeDirectory('imports/roam');
        $disk->makeDirectory('media');

        foreach ($urls as $index => $url) {
            $temporary = null;

            try {
                $this->assertAllowedUrl($url);
                $canonicalUrl = $this->canonicalUrl($url);
                $mediaId = RoamExport::mediaId($canonicalUrl, $workspaceId);
                $existing = Media::find($mediaId);

                if ($existing) {
                    $mediaByUrl[$url] = $this->descriptor($existing);
                    $report->attachmentsReused++;

                    continue;
                }

                $temporary = $disk->path('imports/roam/'.hash('sha256', $url).'.part');
                @unlink($temporary);
                $download = $this->fetcher->fetch($url, $temporary, $maximumBytes);
                $hash = hash_file('sha256', $temporary);

                if (! is_string($hash)) {
                    throw new RuntimeException('Unable to hash the downloaded attachment.');
                }

                $size = filesize($temporary);
                if ($size === false || $size < 1) {
                    throw new RuntimeException('Downloaded attachment is empty.');
                }

                $sameBlob = Media::where('filename', $hash)->first();
                $finalPath = $disk->path("media/{$hash}");

                if (is_file($finalPath)) {
                    @unlink($temporary);
                } elseif (! @rename($temporary, $finalPath)) {
                    throw new RuntimeException('Unable to move the attachment into local media storage.');
                }

                if ($sameBlob) {
                    $mediaByUrl[$url] = $this->descriptor($sameBlob);
                    $report->attachmentsReused++;

                    continue;
                }

                $originalName = $this->originalName($url);
                $mimeType = $this->mimeType($finalPath, $download['mime_type']);
                $payload = [
                    'v' => 1,
                    'id' => $mediaId,
                    'hash' => $hash,
                    'original_name' => $originalName,
                    'mime_type' => $mimeType,
                    'size' => $size,
                ];

                $this->sync->push([[
                    'op_id' => RoamExport::opId("media:{$mediaId}:{$hash}", $workspaceId),
                    'client_id' => $clock->clientId,
                    'hlc' => $clock->now(),
                    'type' => 'media.create',
                    'payload' => $payload,
                ]]);

                $media = Media::findOrFail($mediaId);
                $mediaByUrl[$url] = $this->descriptor($media);
                $report->attachmentsImported++;
            } catch (Throwable $exception) {
                if (is_string($temporary)) {
                    @unlink($temporary);
                }

                $report->attachmentsFailed++;
                $report->warnings[] = sprintf(
                    'Attachment %s could not be imported: %s',
                    $this->safeName($url),
                    $exception->getMessage(),
                );
            }

            if ($progress) {
                $progress($index + 1, count($urls));
            }
        }

        return $mediaByUrl;
    }

    /** @return array{id: string, original_name: string, mime_type: string, size: int} */
    private function descriptor(Media $media): array
    {
        return [
            'id' => $media->id,
            'original_name' => $media->original_name,
            'mime_type' => $media->mime_type,
            'size' => $media->size,
        ];
    }

    private function assertAllowedUrl(string $url): void
    {
        $parts = parse_url($url);

        if (($parts['scheme'] ?? null) !== 'https'
            || strtolower((string) ($parts['host'] ?? '')) !== 'firebasestorage.googleapis.com') {
            throw new RuntimeException('Only HTTPS Roam Firebase uploads may be downloaded.');
        }
    }

    private function canonicalUrl(string $url): string
    {
        $parts = parse_url($url);

        return sprintf(
            '%s://%s%s',
            strtolower((string) ($parts['scheme'] ?? 'https')),
            strtolower((string) ($parts['host'] ?? '')),
            (string) ($parts['path'] ?? ''),
        );
    }

    private function originalName(string $url): string
    {
        $path = rawurldecode((string) parse_url($url, PHP_URL_PATH));
        $name = basename($path);
        $name = preg_replace('/[\x00-\x1F\x7F]/u', '', $name) ?: 'roam-upload';

        if (mb_strlen($name) > 240) {
            $extension = pathinfo($name, PATHINFO_EXTENSION);
            $suffix = $extension !== '' ? '.'.$extension : '';
            $name = mb_substr(pathinfo($name, PATHINFO_FILENAME), 0, 240 - mb_strlen($suffix)).$suffix;
        }

        return $name;
    }

    private function safeName(string $url): string
    {
        try {
            return $this->originalName($url);
        } catch (Throwable) {
            return 'identified by '.substr(hash('sha256', $url), 0, 12);
        }
    }

    private function mimeType(string $path, ?string $header): string
    {
        if ($header && $header !== 'application/octet-stream') {
            return $header;
        }

        $detected = (new \finfo(FILEINFO_MIME_TYPE))->file($path);

        return is_string($detected) && $detected !== ''
            ? $detected
            : 'application/octet-stream';
    }
}
