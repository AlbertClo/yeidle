import { contextBridge, ipcRenderer } from 'electron';

const api = {
    spikeSqlite: (): Promise<{ version: string; hits: unknown[] }> =>
        ipcRenderer.invoke('spike:sqlite'),
};

contextBridge.exposeInMainWorld('yeidle', api);

export type YeidleApi = typeof api;
