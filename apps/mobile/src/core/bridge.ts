import { Browser } from '@capacitor/browser';

import type {
    CoreRequest,
    CoreResponse,
    UploadedFile,
    WorkerMessage,
} from './protocol';
import CoreWorker from './worker?worker';

/**
 * Connects the desktop renderer to the core worker, standing in for what
 * Electron provides: requests the renderer makes to the app (the JSON API
 * and Inertia's page requests) are answered by the core instead of the
 * network, and `window.Native` reports document changes.
 */

const worker = new CoreWorker();
const pending = new Map<number, (response: CoreResponse) => void>();
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
        case 'response':
            pending.get(message.id)?.(message);
            pending.delete(message.id);
            break;
    }
};

// The app's own routes; everything else goes to the network
const APP_PATHS = /^\/(api\/|pages(\/|$)|navigation-history(\/|$)|$)/;

function isCoreRequest(request: Request): boolean {
    const url = new URL(request.url);

    return (
        url.origin === window.location.origin && APP_PATHS.test(url.pathname)
    );
}

/** Sends one request to the core, as Electron's protocol handler does. */
export async function coreFetch(request: Request): Promise<Response> {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
    });

    let body: Record<string, unknown> = {};
    const files: Record<string, UploadedFile> = {};
    const contentType = headers['content-type'] ?? '';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (contentType.includes('multipart/form-data')) {
            for (const [key, value] of (await request.formData()).entries()) {
                if (typeof value === 'string') {
                    body[key] = value;
                } else {
                    files[key] = {
                        name: value.name,
                        type: value.type,
                        bytes: new Uint8Array(await value.arrayBuffer()),
                    };
                }
            }
        } else {
            const text = await request.text();

            if (contentType.includes('application/x-www-form-urlencoded')) {
                body = Object.fromEntries(new URLSearchParams(text));
            } else if (text !== '') {
                try {
                    const parsed: unknown = JSON.parse(text);
                    body =
                        parsed !== null &&
                        typeof parsed === 'object' &&
                        !Array.isArray(parsed)
                            ? (parsed as Record<string, unknown>)
                            : {};
                } catch {
                    body = {};
                }
            }
        }
    }

    await coreReady;

    const id = nextId++;
    const message: CoreRequest = {
        type: 'request',
        id,
        method: request.method,
        url: request.url,
        headers,
        body,
        files,
    };
    const response = await new Promise<CoreResponse>((resolve) => {
        pending.set(id, resolve);
        worker.postMessage(message);
    });

    return new Response(
        response.body === null || request.method === 'HEAD'
            ? null
            : (response.body as BodyInit),
        { status: response.status, headers: response.headers },
    );
}

/** Routes the renderer's fetches for app URLs to the core. */
export function installCoreFetch(): void {
    const networkFetch = window.fetch.bind(window);

    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);

        return isCoreRequest(request)
            ? coreFetch(request)
            : networkFetch(request);
    };
}

/** `window.Native` as the renderer expects it; there are no window controls. */
export function installNative(): void {
    window.Native = {
        subscribeDocumentChanges(callback: (documentIds: string[]) => void) {
            changeListeners.add(callback);

            return () => changeListeners.delete(callback);
        },
    };
}

/**
 * Media elements point at /api/media/<id>, which only the core can answer
 * and which isn't a fetch: load each file through the core and show it from
 * a blob URL.
 */
export function installMediaUrls(): void {
    const loaded = new Map<string, Promise<string>>();
    const MEDIA = /^\/api\/media\/[^/]+$/;

    const blobUrl = (path: string) => {
        let url = loaded.get(path);

        if (!url) {
            url = coreFetch(new Request(new URL(path, window.location.origin)))
                .then((response) => response.blob())
                .then((blob) => URL.createObjectURL(blob));
            loaded.set(path, url);
        }

        return url;
    };

    const rewrite = (element: Element) => {
        const src = element.getAttribute('src');

        if (src && MEDIA.test(src)) {
            element.setAttribute('data-media-src', src);
            element.removeAttribute('src');
            void blobUrl(src).then((url) => {
                if (element.getAttribute('data-media-src') === src) {
                    element.setAttribute('src', url);
                }
            });
        }
    };

    new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                rewrite(mutation.target as Element);
            }

            for (const node of mutation.addedNodes) {
                if (node instanceof Element) {
                    rewrite(node);
                    node.querySelectorAll('[src]').forEach(rewrite);
                }
            }
        }
    }).observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['src'],
    });
}
