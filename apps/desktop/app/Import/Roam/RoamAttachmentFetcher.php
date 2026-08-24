<?php

namespace App\Import\Roam;

use Illuminate\Support\Facades\Http;
use RuntimeException;

class RoamAttachmentFetcher
{
    /** @return array{mime_type: ?string, size: int} */
    public function fetch(string $url, string $target, int $maximumBytes): array
    {
        $response = Http::connectTimeout(15)
            ->timeout(300)
            ->retry(2, 500)
            ->withOptions(['sink' => $target])
            ->get($url);

        if (! $response->successful()) {
            throw new RuntimeException("Download returned HTTP {$response->status()}.");
        }

        clearstatcache(true, $target);
        $size = is_file($target) ? filesize($target) : false;

        if ($size === false || $size < 1) {
            throw new RuntimeException('Download did not produce a file.');
        }

        if ($size > $maximumBytes) {
            throw new RuntimeException('Download exceeds the configured maximum attachment size.');
        }

        $contentType = $response->header('Content-Type');
        $mimeType = is_string($contentType) ? trim(explode(';', $contentType)[0]) : null;

        return ['mime_type' => $mimeType ?: null, 'size' => $size];
    }
}
