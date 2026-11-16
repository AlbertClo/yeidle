/**
 * Messages between the WebView and the core worker. Requests and responses
 * mirror the core's AppRequest/AppResponse in a form postMessage can copy.
 */

export type UploadedFile = { name: string; type: string; bytes: Uint8Array };

export type CoreRequest = {
    type: 'request';
    id: number;
    method: string;
    /** Absolute URL on the app's origin. */
    url: string;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    body: Record<string, unknown>;
    files: Record<string, UploadedFile>;
};

export type CoreResponse = {
    type: 'response';
    id: number;
    status: number;
    headers: Record<string, string>;
    body: Uint8Array | string | null;
};

export type WorkerMessage =
    | CoreResponse
    | { type: 'ready' }
    | { type: 'failed'; message: string }
    | { type: 'open-external'; url: string }
    | { type: 'documents-changed'; documentIds: string[] };
