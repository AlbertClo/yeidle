/** Messages between the UI and the core worker. */

export type CoreRequest = {
    id: number;
    method: string;
    /** Path and query, e.g. `/api/pages`. */
    path: string;
    body?: Record<string, unknown>;
};

export type CoreResponse = {
    type: 'response';
    id: number;
    status: number;
    body: string;
};

export type WorkerMessage =
    | CoreResponse
    | { type: 'ready' }
    | { type: 'failed'; message: string }
    | { type: 'open-external'; url: string }
    | { type: 'documents-changed'; documentIds: string[] };
