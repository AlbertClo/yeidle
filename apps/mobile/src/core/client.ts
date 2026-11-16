import { Browser } from '@capacitor/browser';

import type { CoreRequest, WorkerMessage } from './protocol';
import CoreWorker from './worker?worker';

/**
 * The UI's side of the core worker: `api()` sends a request to the app
 * server and resolves with its JSON, like fetch('/api/...') on desktop.
 */

export class ApiError extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

const worker = new CoreWorker();
const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const changeListeners = new Set<(documentIds: string[]) => void>();
let nextId = 1;
let markReady: () => void;
let markFailed: (error: Error) => void;

export const coreReady = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markFailed = reject;
});

worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data;

    switch (message.type) {
        case 'ready':
            markReady();
            break;
        case 'failed':
            markFailed(new Error(message.message));
            break;
        case 'open-external':
            void Browser.open({ url: message.url });
            break;
        case 'documents-changed':
            changeListeners.forEach((listener) =>
                listener(message.documentIds),
            );
            break;
        case 'response': {
            const request = pending.get(message.id);
            pending.delete(message.id);

            if (!request) {
                break;
            }

            const body = message.body === '' ? null : JSON.parse(message.body);

            if (message.status >= 400) {
                request.reject(
                    new ApiError(
                        body?.message ?? `Request failed (${message.status})`,
                        message.status,
                    ),
                );
            } else {
                request.resolve(body);
            }

            break;
        }
    }
};

export function api<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
): Promise<T> {
    const id = nextId++;
    const request: CoreRequest = { id, method, path, body };

    return new Promise<T>((resolve, reject) => {
        pending.set(id, {
            resolve: resolve as (value: unknown) => void,
            reject,
        });
        worker.postMessage(request);
    });
}

/** Closes the browser tab sign-in opened, returning to the app. */
export function closeBrowser(): void {
    void Browser.close().catch(() => undefined);
}

/** Called after every committed change, local or synced. */
export function onDocumentsChanged(
    listener: (documentIds: string[]) => void,
): () => void {
    changeListeners.add(listener);

    return () => changeListeners.delete(listener);
}
