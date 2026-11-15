<?php

namespace App\Console\Commands;

use Aws\S3\S3ClientInterface;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Throwable;

#[Signature('blobs:ensure-bucket')]
#[Description('Create the configured S3 blob bucket when it does not exist')]
class EnsureBlobBucket extends Command
{
    /**
     * The client is resolved here rather than in the constructor: artisan
     * constructs every command when it boots (including during deploy
     * builds, before storage is configured).
     */
    public function handle(S3ClientInterface $s3): int
    {
        $bucket = config('filesystems.disks.s3.bucket');

        if (! is_string($bucket) || trim($bucket) === '') {
            $this->error('The S3 disk bucket is not configured. Set AWS_BUCKET before running this command.');

            return self::FAILURE;
        }

        try {
            if ($s3->doesBucketExistV2($bucket, false)) {
                $this->info("Blob bucket [{$bucket}] already exists.");

                return self::SUCCESS;
            }

            $s3->createBucket(['Bucket' => $bucket]);
        } catch (Throwable $exception) {
            $this->error("Unable to ensure blob bucket [{$bucket}]: {$exception->getMessage()}");

            return self::FAILURE;
        }

        $this->info("Blob bucket [{$bucket}] created.");

        return self::SUCCESS;
    }
}
