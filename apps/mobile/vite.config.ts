import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// Loro's self-loading browser build (its bundler build needs a WebAssembly plugin)
const loroBrowserBuild = resolve(
    dirname(fileURLToPath(import.meta.resolve('loro-crdt'))),
    '../browser/index.js',
);

const aliases = [
    { find: /^loro-crdt$/, replacement: loroBrowserBuild },
    // The core's only Node built-in on its request path
    {
        find: /^node:crypto$/,
        replacement: resolve(import.meta.dirname, 'src/shims/nodeCrypto.ts'),
    },
];

export default defineConfig({
    plugins: [vue()],
    resolve: { alias: aliases },
    // The core runs in a module worker, which needs the same aliases
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', 'loro-crdt'] },
    build: { target: 'es2022' },
    server: {
        // SQLite's OPFS storage pool needs no cross-origin isolation, so no
        // COOP/COEP headers here
        port: 5180,
    },
});
