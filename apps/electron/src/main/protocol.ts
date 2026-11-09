import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

import type {
    AppRequest,
    AppResponse,
    UploadedFile,
} from '@yeidle/core/http/http';

/**
 * Converts between Electron protocol requests and the core's AppRequest /
 * AppResponse.
 */

export async function toAppRequest(request: Request): Promise<AppRequest> {
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
    });

    let body: Record<string, unknown> = {};
    const files: Record<string, UploadedFile> = {};
    const contentType = headers['content-type'] ?? '';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        if (contentType.includes('multipart/form-data')) {
            const form = await request.formData();

            for (const [key, value] of form.entries()) {
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

            if (text !== '') {
                if (contentType.includes('application/x-www-form-urlencoded')) {
                    body = Object.fromEntries(new URLSearchParams(text));
                } else {
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
    }

    return { method: request.method, url, headers, body, files };
}

export async function toResponse(response: AppResponse): Promise<Response> {
    const headers = new Headers(response.headers);
    const body = response.body;

    if (body === null) {
        return new Response(null, { status: response.status, headers });
    }

    if (typeof body === 'string' || body instanceof Uint8Array) {
        return new Response(body as BodyInit, {
            status: response.status,
            headers,
        });
    }

    if ('file' in body) {
        if (!fs.existsSync(body.file)) {
            return new Response('Not found', { status: 404 });
        }

        headers.set('content-length', String(fs.statSync(body.file).size));

        return new Response(
            Readable.toWeb(fs.createReadStream(body.file)) as ReadableStream,
            { status: response.status, headers },
        );
    }

    const encoder = new TextEncoder();
    const iterator = body.stream[Symbol.asyncIterator]();

    return new Response(
        new ReadableStream({
            async pull(controller) {
                const { value, done } = await iterator.next();

                if (done) {
                    controller.close();
                } else {
                    controller.enqueue(encoder.encode(value));
                }
            },
            async cancel() {
                await iterator.return?.();
            },
        }),
        { status: response.status, headers },
    );
}

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
};

/** Built renderer assets (production). */
export function serveStatic(root: string, pathname: string): Response {
    const file = path.normalize(path.join(root, decodeURIComponent(pathname)));

    if (
        !file.startsWith(root) ||
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile()
    ) {
        return new Response('Not found', { status: 404 });
    }

    return new Response(fs.readFileSync(file), {
        headers: {
            'content-type':
                MIME_TYPES[path.extname(file)] ?? 'application/octet-stream',
        },
    });
}

/**
 * Renderer assets from the Vite dev server (development). Node's fetch, not
 * Electron's net module, which fails to reach the dev server here.
 */
export async function proxyToDevServer(
    devUrl: string,
    request: Request,
): Promise<Response> {
    const url = new URL(request.url);
    const response = await fetch(`${devUrl}${url.pathname}${url.search}`, {
        method: request.method,
    });

    return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: response.headers,
    });
}
