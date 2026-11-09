import { resolve } from 'node:path';
import vue from '@vitejs/plugin-vue';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin({ exclude: ['@yeidle/core'] })],
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
    },
    renderer: {
        resolve: {
            alias: { '@': resolve('src/renderer/src') },
        },
        plugins: [vue()],
    },
});
