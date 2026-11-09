import type { YeidleApi } from './index';

declare global {
    interface Window {
        yeidle: YeidleApi;
    }
}
