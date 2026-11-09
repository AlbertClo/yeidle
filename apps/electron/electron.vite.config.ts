import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
    main: {
        // The core is TypeScript source, so it's bundled into the main process
        plugins: [externalizeDepsPlugin({ exclude: ['@yeidle/core'] })],
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        resolve: {
            alias: { '@': resolve('src/renderer/src') },
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
