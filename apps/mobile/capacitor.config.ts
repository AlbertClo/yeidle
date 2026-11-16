import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
    appId: 'com.yeidle.app',
    appName: 'Yeidle',
    webDir: 'dist',
    android: {
        // Served from https://localhost, a secure context (OPFS needs one)
        allowMixedContent: false,
    },
};

export default config;
