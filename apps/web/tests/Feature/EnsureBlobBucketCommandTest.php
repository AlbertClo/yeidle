<?php

use Aws\Result;
use Aws\S3\S3ClientInterface;

test('it creates the configured blob bucket when it is missing', function () {
    config()->set('filesystems.disks.s3.bucket', 'yeidle');

    $s3 = Mockery::mock(S3ClientInterface::class);
    $s3->shouldReceive('doesBucketExistV2')
        ->once()
        ->with('yeidle', false)
        ->andReturnFalse();
    $s3->shouldReceive('createBucket')
        ->once()
        ->with(['Bucket' => 'yeidle'])
        ->andReturn(new Result);
    $this->app->instance(S3ClientInterface::class, $s3);

    $this->artisan('blobs:ensure-bucket')
        ->expectsOutput('Blob bucket [yeidle] created.')
        ->assertSuccessful();
});

test('it succeeds without creating an existing blob bucket', function () {
    config()->set('filesystems.disks.s3.bucket', 'yeidle');

    $s3 = Mockery::mock(S3ClientInterface::class);
    $s3->shouldReceive('doesBucketExistV2')
        ->once()
        ->with('yeidle', false)
        ->andReturnTrue();
    $s3->shouldNotReceive('createBucket');
    $this->app->instance(S3ClientInterface::class, $s3);

    $this->artisan('blobs:ensure-bucket')
        ->expectsOutput('Blob bucket [yeidle] already exists.')
        ->assertSuccessful();
});

test('it fails clearly when the blob bucket is not configured', function () {
    config()->set('filesystems.disks.s3.bucket', '');

    $s3 = Mockery::mock(S3ClientInterface::class);
    $s3->shouldNotReceive('doesBucketExistV2');
    $s3->shouldNotReceive('createBucket');
    $this->app->instance(S3ClientInterface::class, $s3);

    $this->artisan('blobs:ensure-bucket')
        ->expectsOutput('The S3 disk bucket is not configured. Set AWS_BUCKET before running this command.')
        ->assertFailed();
});
