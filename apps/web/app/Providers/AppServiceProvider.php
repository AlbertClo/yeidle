<?php

namespace App\Providers;

use Aws\S3\S3Client;
use Aws\S3\S3ClientInterface;
use Carbon\CarbonImmutable;
use Illuminate\Support\Arr;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(S3ClientInterface::class, function (): S3ClientInterface {
            /** @var array<string, mixed> $config */
            $config = config('filesystems.disks.s3', []);
            $config += ['version' => 'latest'];

            if (! empty($config['key']) && ! empty($config['secret'])) {
                $config['credentials'] = Arr::only($config, ['key', 'secret']);

                if (! empty($config['token'])) {
                    $config['credentials']['token'] = $config['token'];
                }
            }

            return new S3Client(Arr::except($config, ['token']));
        });
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configureDefaults();
    }

    /**
     * Configure default behaviors for production-ready applications.
     */
    protected function configureDefaults(): void
    {
        Date::use(CarbonImmutable::class);

        DB::prohibitDestructiveCommands(
            app()->isProduction(),
        );

        Password::defaults(fn (): ?Password => app()->isProduction()
            ? Password::min(12)
                ->mixedCase()
                ->letters()
                ->numbers()
                ->symbols()
                ->uncompromised()
            : null,
        );
    }
}
