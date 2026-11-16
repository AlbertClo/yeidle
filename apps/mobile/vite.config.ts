import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * Yeidle on Android builds the desktop renderer (apps/electron/src/renderer)
 * with the same Vue and Tailwind setup, plus a bootstrap (src/main.ts) that
 * connects it to the core worker instead of Electron.
 */

const renderer = resolve(import.meta.dirname, '../electron/src/renderer');

// Loro's self-loading browser build (its bundler build needs a WebAssembly plugin)
const loroBrowserBuild = resolve(
    dirname(fileURLToPath(import.meta.resolve('loro-crdt'))),
    '../browser/index.js',
);

const aliases = [
    { find: '@', replacement: resolve(renderer, 'src') },
    { find: /^loro-crdt$/, replacement: loroBrowserBuild },
    // The core's only Node built-in on its request path
    {
        find: /^node:crypto$/,
        replacement: resolve(import.meta.dirname, 'src/shims/nodeCrypto.ts'),
    },
];

export default defineConfig({
    plugins: [
        tailwindcss(),
        vue({
            template: {
                transformAssetUrls: { base: null, includeAbsolute: false },
            },
        }),
    ],
    resolve: { alias: aliases },
    // The renderer's favicon and other static files
    publicDir: resolve(renderer, 'public'),
    // The core runs in a module worker, which needs the same aliases
    worker: { format: 'es' },
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', 'loro-crdt'] },
    build: { target: 'es2022' },
    server: {
        port: 5180,
        // The renderer lives outside this app's folder
        fs: { allow: [resolve(import.meta.dirname, '../..')] },
    },
});
