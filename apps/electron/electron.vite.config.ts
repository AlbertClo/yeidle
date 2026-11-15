import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Loro's self-loading browser build in dev too; the "development" export
// condition would pick its bundler build, which needs a WebAssembly plugin
const loroBrowserBuild = resolve(
    dirname(fileURLToPath(import.meta.resolve('loro-crdt'))),
    '../browser/index.js',
);

export default defineConfig({
    main: {
        // Everything is bundled into the main process (the core is TypeScript
        // source) except Loro, whose Node build loads its WebAssembly from
        // its own directory. A packaged app then needs only out/ and
        // node_modules/loro-crdt.
        build: {
            externalizeDeps: false,
            rollupOptions: {
                external: ['loro-crdt'],
            },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        resolve: {
            alias: [
                { find: '@', replacement: resolve('src/renderer/src') },
                { find: /^loro-crdt$/, replacement: loroBrowserBuild },
            ],
        },
        plugins: [
            tailwindcss(),
            vue({
                template: {
                    transformAssetUrls: {
                        base: null,
                        includeAbsolute: false,
                    },
                },
            }),
        ],
        // Pages are served from yeidle://app, so hot reload has to reach the
        // dev server directly
        server: {
            hmr: { protocol: 'ws', host: 'localhost' },
        },
        optimizeDeps: {
            exclude: ['loro-crdt'],
        },
    },
});
