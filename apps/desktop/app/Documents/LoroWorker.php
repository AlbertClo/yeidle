<?php

namespace App\Documents;

use Illuminate\Support\Facades\Process;
use RuntimeException;

/**
 * Runs the bundled Loro document worker (bootstrap/loro-worker.cjs, built by
 * `npm run build:loro`) with a JSON request on stdin.
 */
class LoroWorker
{
    /**
     * @param  array{documents: list<array{id: string, snapshot?: ?string, updates?: list<string>}>, actions?: list<array<string, mixed>>, message?: string}  $request
     * @return list<array{id: string, update: ?string, snapshot: ?string, rows: array}>
     */
    public function run(array $request): array
    {
        $script = base_path('bootstrap/loro-worker.cjs');

        if (! is_file($script)) {
            throw new RuntimeException('The document worker is missing. Run `npm run build:loro`.');
        }

        $result = Process::input(json_encode($request, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE))
            ->env(['ELECTRON_RUN_AS_NODE' => '1'])
            ->timeout(120)
            ->run([$this->nodeBinary(), $script]);

        if (! $result->successful()) {
            throw new RuntimeException('The document worker failed: '.mb_substr($result->errorOutput(), 0, 1000));
        }

        $data = json_decode($result->output(), true, 512, JSON_THROW_ON_ERROR);

        if (! is_array($data['documents'] ?? null)) {
            throw new RuntimeException('The document worker returned an invalid result.');
        }

        return $data['documents'];
    }

    /**
     * An explicit binary wins. Inside the packaged app there is no `node` on
     * PATH, but the Electron binary that launched PHP runs scripts as Node
     * when ELECTRON_RUN_AS_NODE is set.
     */
    private function nodeBinary(): string
    {
        $configured = config('documents.node_binary');

        if (is_string($configured) && $configured !== '') {
            return $configured;
        }

        return $this->electronAncestor() ?? 'node';
    }

    private function electronAncestor(): ?string
    {
        if (! env('NATIVEPHP_RUNNING') || PHP_OS_FAMILY !== 'Linux') {
            return null;
        }

        $pid = getmypid();

        for ($depth = 0; $depth < 6 && $pid > 1; $depth++) {
            $status = @file_get_contents("/proc/{$pid}/status");

            if ($status === false || preg_match('/^PPid:\s+(\d+)/m', $status, $match) !== 1) {
                return null;
            }

            $pid = (int) $match[1];
            $exe = @readlink("/proc/{$pid}/exe");

            if ($exe !== false && ! str_contains(basename($exe), 'php')) {
                return $exe;
            }
        }

        return null;
    }
}
