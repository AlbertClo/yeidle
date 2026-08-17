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
    public function __construct(private S3ClientInterface $s3)
    {
        parent::__construct();
    }

    public function handle(): int
    {
        $bucket = config('filesystems.disks.s3.bucket');

        if (! is_string($bucket) || trim($bucket) === '') {
            $this->error('The S3 disk bucket is not configured. Set AWS_BUCKET before running this command.');

            return self::FAILURE;
        }

        try {
            if ($this->s3->doesBucketExistV2($bucket, false)) {
                $this->info("Blob bucket [{$bucket}] already exists.");

                return self::SUCCESS;
            }

            $this->s3->createBucket(['Bucket' => $bucket]);
        } catch (Throwable $exception) {
            $this->error("Unable to ensure blob bucket [{$bucket}]: {$exception->getMessage()}");

            return self::FAILURE;
        }

        $this->info("Blob bucket [{$bucket}] created.");

        return self::SUCCESS;
    }
}
