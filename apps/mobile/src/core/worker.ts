/// <reference lib="webworker" />
import { cloudFor } from '@yeidle/core/app/cloud/index';
import { createContext, fileSettings } from '@yeidle/core/app/context';
import type { AppContext } from '@yeidle/core/app/context';
import type { Host } from '@yeidle/core/app/host';
import { createAppServer } from '@yeidle/core/app/server';
import { Workspaces } from '@yeidle/core/app/workspaces';
import type { AppResponse } from '@yeidle/core/http/http';
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
        // Pages load as Inertia JSON; the WebView's index.html is the shell
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
        const { router, context } = await ready;
        const result = await router.handle({
            method: request.method,
            url: new URL(request.url),
            headers: request.headers,
            body: request.body,
            files: request.files,
        });

        response = {
            type: 'response',
            id: request.id,
            status: result.status,
            headers: result.headers,
            body: await responseBody(result.body, context),
        };
    } catch (error) {
        response = {
            type: 'response',
            id: request.id,
            status: 500,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                message: error instanceof Error ? error.message : String(error),
            }),
        };
    }

    post(response);
};

/** The core's response body as bytes or text (files are read, streams joined). */
async function responseBody(
    body: AppResponse['body'],
    context: AppContext,
): Promise<Uint8Array | string | null> {
    if (
        body === null ||
        typeof body === 'string' ||
        body instanceof Uint8Array
    ) {
        return body;
    }

    if ('file' in body) {
        return context.host.files.readFile(body.file);
    }

    let text = '';

    for await (const chunk of body.stream) {
        text += chunk;
    }

    return text;
}
