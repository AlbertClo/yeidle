<?php

namespace App\Providers;

use App\Accounts\CloudAccountStore;
use App\Preferences\UserKeyBindings;
use App\Workspaces\WorkspaceIndex;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;
use RuntimeException;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->singleton(WorkspaceIndex::class, function (Application $app): WorkspaceIndex {
            $connection = config('database.default');
            $databasePath = is_string($connection)
                ? config("database.connections.{$connection}.database")
                : null;

            if (! is_string($databasePath) || $databasePath === '' || $databasePath === ':memory:') {
                throw new RuntimeException('The NativePHP database path is unavailable.');
            }

            $storagePath = config('filesystems.disks.local.root');

            return new WorkspaceIndex(
                $databasePath,
                is_string($storagePath) ? $storagePath : null,
            );
        });

        $this->app->singleton(CloudAccountStore::class, function (Application $app): CloudAccountStore {
            return new CloudAccountStore(
                $app->make(WorkspaceIndex::class)->appDataDirectory()
                    .DIRECTORY_SEPARATOR.'cloud-account.json',
            );
        });

        $this->app->singleton(UserKeyBindings::class, function (Application $app): UserKeyBindings {
            return new UserKeyBindings(
                $app->make(WorkspaceIndex::class)->appDataDirectory()
                    .DIRECTORY_SEPARATOR.'user-preferences.json',
                $app->make(CloudAccountStore::class),
            );
        });
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        if (config('nativephp-internal.running') && ! app()->environment('testing')) {
            $this->app->make(WorkspaceIndex::class)->configureActiveConnection();
        }

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
