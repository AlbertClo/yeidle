/// <reference lib="webworker" />
import { cloudFor } from '@yeidle/core/app/cloud/index';
import { createContext, fileSettings } from '@yeidle/core/app/context';
import type { AppContext } from '@yeidle/core/app/context';
import type { Host } from '@yeidle/core/app/host';
import { createAppServer } from '@yeidle/core/app/server';
import { Workspaces } from '@yeidle/core/app/workspaces';
import type { Router } from '@yeidle/core/http/router';

import { sqliteFiles } from './files';
import { openStoragePool } from './sqlite';
import type { CoreRequest, CoreResponse, WorkerMessage } from './protocol';

/**
 * The core on Android, the counterpart of Electron's main process: it owns
 * the workspace databases and cloud sync, and answers the UI's requests
 * through the same app server (JSON API) the desktop windows use.
 */

declare const self: DedicatedWorkerGlobalScope;

const DATA_DIRECTORY = '/yeidle';
const CLOUD_URL =
    import.meta.env.VITE_YEIDLE_CLOUD_URL ?? 'https://app.yeidle.com';

const post = (message: WorkerMessage) => self.postMessage(message);

async function start(): Promise<{ router: Router; context: AppContext }> {
    const pool = await openStoragePool();
    const files = sqliteFiles(
        pool.open(`${DATA_DIRECTORY}/app-files.sqlite`),
        pool,
    );
    const host: Host = {
        platform: 'android',
        appVersion: import.meta.env.VITE_APP_VERSION ?? '0.1.0',
        dataDirectory: DATA_DIRECTORY,
        files,
        // Files and folders can't be handed to other apps from here yet
        openPath: () => undefined,
        showItemInFolder: () => undefined,
        openExternal: (url) => post({ type: 'open-external', url }),
        cloudUrl: CLOUD_URL,
        deviceName: 'Yeidle on Android',
        fetch: async (url) => {
            const response = await fetch(url);

            return {
                status: response.status,
                contentType: response.headers.get('content-type'),
                bytes: new Uint8Array(await response.arrayBuffer()),
            };
        },
    };
    const workspaces = new Workspaces(host, (path) => pool.open(path));
    const context = createContext(host, workspaces, fileSettings(host));
    const router = createAppServer(context, {
        version: 'mobile',
        // The mobile UI only uses the JSON API
        renderHtml: () => '',
    });

    workspaces.active();
    context
        .documents()
        .onChange((documentIds) =>
            post({ type: 'documents-changed', documentIds }),
        );
    cloudFor(context).scheduler.start();

    return { router, context };
}

const ready = start();

ready.then(
    () => post({ type: 'ready' }),
    (error: unknown) =>
        post({
            type: 'failed',
            message: error instanceof Error ? error.message : String(error),
        }),
);

self.onmessage = async (event: MessageEvent<CoreRequest>) => {
    const request = event.data;
    let response: CoreResponse;

    try {
        const { router } = await ready;
        const result = await router.handle({
            method: request.method,
            url: new URL(request.path, 'yeidle://app'),
            headers: { accept: 'application/json' },
            body: request.body ?? {},
            files: {},
        });
        const body =
            typeof result.body === 'string'
                ? result.body
                : result.body instanceof Uint8Array
                  ? new TextDecoder().decode(result.body)
                  : '';

        response = {
            type: 'response',
            id: request.id,
            status: result.status,
            body,
        };
    } catch (error) {
        response = {
            type: 'response',
            id: request.id,
            status: 500,
            body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error),
            }),
        };
    }

    post(response);
};
