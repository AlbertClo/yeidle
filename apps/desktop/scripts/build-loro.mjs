import { build } from 'esbuild';

// Self-contained worker for PHP: the base64 build of loro-crdt inlines its
// WebAssembly, so the bundle runs without node_modules (the packaged app
// strips them)
await build({
    entryPoints: ['resources/js/loro/worker.ts'],
    outfile: 'bootstrap/loro-worker.cjs',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    minify: true,
    alias: { 'loro-crdt': 'loro-crdt/base64' },
    legalComments: 'eof',
});
