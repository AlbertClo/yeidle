/** Talking to Yeidle Cloud (the Laravel app) over HTTP. */

export type CloudFetch = (
    input: string,
    init?: RequestInit,
) => Promise<Response>;

export class CloudError extends Error {
    constructor(
        message: string,
        /** HTTP status, or null when the server could not be reached. */
        readonly status: number | null = null,
    ) {
        super(message);
    }
}

export type CloudResponse = {
    status: number;
    ok: boolean;
    body: Record<string, unknown> | null;
};

export async function cloudRequest(
    fetchImpl: CloudFetch,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: {
        token?: string;
        json?: unknown;
        form?: Record<string, string>;
        timeoutMs?: number;
    } = {},
): Promise<CloudResponse> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;

    if (options.token) {
        headers.Authorization = `Bearer ${options.token}`;
    }

    if (options.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(options.form).toString();
    }

    let response: Response;

    try {
        response = await fetchImpl(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
    } catch {
        throw new CloudError('Could not reach Yeidle Cloud.');
    }

    let parsed: Record<string, unknown> | null = null;

    try {
        const text = await response.text();
        const value: unknown = text === '' ? null : JSON.parse(text);
        parsed =
            value !== null && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : null;
    } catch {
        parsed = null;
    }

    return { status: response.status, ok: response.ok, body: parsed };
}

/** The server's message, or a fallback naming the HTTP status. */
export function cloudMessage(
    response: CloudResponse,
    fallback: string,
): string {
    const message = response.body?.message;

    return typeof message === 'string' && message !== ''
        ? message
        : `${fallback} (HTTP ${response.status}).`;
}
