<?php

namespace App\Console\Commands;

use App\Import\Roam\RoamImporter;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Console\Command;
use Native\Desktop\NativeServiceProvider;
use Symfony\Component\Console\Helper\ProgressBar;
use Throwable;

class ImportRoam extends Command
{
    protected $signature = 'roam:import
        {path : Path to a Roam JSON export}
        {--dry-run : Analyse and validate without writing data or downloading attachments}
        {--without-files : Preserve Roam upload URLs instead of downloading them}
        {--workspace= : Import into an existing local workspace ID}
        {--new-workspace= : Create, activate, and import into a new local workspace}';

    protected $description = 'Import a Roam Research JSON export into the local Yeidle database';

    public function handle(): int
    {
        $path = (string) $this->argument('path');
        $dryRun = (bool) $this->option('dry-run');
        $currentPhase = null;
        $progressBar = null;

        $rewroteNativeDatabase = false;

        if (! $dryRun
            && app()->environment() !== 'testing'
            && config('app.debug')
            && ! config('nativephp-internal.running')) {
            // Host-side development commands otherwise use database.sqlite,
            // while the running NativePHP app uses database/nativephp.sqlite.
            (new NativeServiceProvider(app()))->rewriteDatabase();
            $rewroteNativeDatabase = true;
        }

        if ($this->option('workspace') && $this->option('new-workspace')) {
            $this->error('Use either --workspace or --new-workspace, not both.');

            return self::FAILURE;
        }

        $workspaceId = 'default';
        $workspaceName = 'test database';

        if (! app()->environment('testing')) {
            if ($dryRun) {
                $workspaceName = trim((string) ($this->option('new-workspace') ?: 'selected workspace'));
                $workspaceId = 'dry-run:'.$workspaceName;
            } else {
                if ($rewroteNativeDatabase) {
                    app()->forgetInstance(WorkspaceIndex::class);
                }

                $workspaces = app(WorkspaceIndex::class);

                try {
                    $workspace = $this->option('new-workspace')
                        ? $workspaces->create((string) $this->option('new-workspace'))
                        : ($this->option('workspace')
                            ? $workspaces->find((string) $this->option('workspace'))
                            : $workspaces->active());

                    $workspaces->activate($workspace['id']);
                    $workspaces->configureActiveConnection($workspace['id']);

                    $workspaceId = $workspace['id'];
                    $workspaceName = $workspace['name'];
                } catch (Throwable $exception) {
                    $this->error($exception->getMessage());

                    return self::FAILURE;
                }
            }
        }

        $this->line("Target workspace: {$workspaceName} [{$workspaceId}]");
        $importer = app(RoamImporter::class);

        try {
            $report = $importer->import(
                $path,
                $dryRun,
                ! $this->option('without-files'),
                $workspaceId,
                function (string $phase, int $current, int $total) use (&$currentPhase, &$progressBar): void {
                    if ($phase !== $currentPhase) {
                        if ($progressBar instanceof ProgressBar) {
                            $progressBar->finish();
                            $this->newLine(2);
                        }

                        $currentPhase = $phase;
                        $this->line($phase === 'attachments' ? 'Importing attachments…' : 'Importing pages and blocks…');
                        $progressBar = $this->output->createProgressBar($total);
                        $progressBar->start();
                    }

                    $progressBar?->setProgress($current);
                },
            );
        } catch (Throwable $exception) {
            if ($progressBar instanceof ProgressBar) {
                $progressBar->clear();
            }

            $this->error($exception->getMessage());

            return self::FAILURE;
        }

        if ($progressBar instanceof ProgressBar) {
            $progressBar->finish();
            $this->newLine(2);
        }

        $rows = [];
        foreach ($report->summary() as $label => $value) {
            $rows[] = [$label, $value];
        }

        $this->table(['Item', 'Count'], $rows);

        foreach ($report->warnings as $warning) {
            $this->warn($warning);
        }

        if ($dryRun) {
            $this->info("Dry run complete for [{$workspaceName}]. No local data or attachments were changed.");
        } else {
            $this->info("Roam import complete in [{$workspaceName}]. Pending operations and blobs will use its cloud sync outbox.");
        }

        return $report->attachmentsFailed > 0 ? self::FAILURE : self::SUCCESS;
    }
}
