/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_YEIDLE_CLOUD_URL?: string;
    readonly VITE_APP_VERSION?: string;
}

declare module '*.vue' {
    import type { DefineComponent } from 'vue';

    const component: DefineComponent<object, object, unknown>;
    export default component;
}
