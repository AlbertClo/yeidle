<?php

namespace App\Console\Commands;

use App\Models\Media;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;

class RehashMedia extends Command
{
    protected $signature = 'media:rehash
        {--path= : Media directory (defaults to the local disk media dir)}';

    protected $description = 'Rename stored media files to the SHA-256 hash of their contents, deduplicating identical files';

    public function handle(): int
    {
        $dir = rtrim($this->option('path') ?: Storage::disk('local')->path('media'), '/');

        if (! is_dir($dir)) {
            $this->error("Media directory not found: {$dir}");

            return self::FAILURE;
        }

        $renamed = 0;
        $deduplicated = 0;

        foreach (Media::all() as $media) {
            if (preg_match('/^[0-9a-f]{64}$/', $media->filename)) {
                continue;
            }

            $path = "{$dir}/{$media->filename}";

            if (! is_file($path)) {
                $this->warn("Missing file for {$media->id}: {$media->filename}");

                continue;
            }

            $hash = hash_file('sha256', $path);
            $target = "{$dir}/{$hash}";

            if (is_file($target)) {
                unlink($path);
                $deduplicated++;
            } else {
                rename($path, $target);
                $renamed++;
            }

            $media->update(['filename' => $hash]);
            $this->line("{$media->original_name} -> {$hash}");
        }

        $this->info("Renamed {$renamed}, deduplicated {$deduplicated}.");

        return self::SUCCESS;
    }
}
