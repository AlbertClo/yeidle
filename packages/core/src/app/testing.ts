import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openNodeDatabase } from '../db/nodeSqlite';
import { Input } from '../http/http';
import type { AppRequest, AppResponse } from '../http/http';
import { Router } from '../http/router';
import type { RequestContext } from '../http/router';
import { nodeFiles } from '../support/nodeFiles';

import { createContext, fileSettings } from './context';
import type { AppContext } from './context';
import type { Host } from './host';
import { Workspaces } from './workspaces';

/**
 * A real app context in a temporary data directory, for tests. Host actions
 * that leave the app (opening files, URLs) are recorded instead.
 */
export function testContext(): AppContext & {
    opened: string[];
    shownInFolder: string[];
    openedUrls: string[];
    downloads: Map<string, { status?: number; contentType?: string; bytes: Uint8Array }>;
    cleanup(): void;
} {
    const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeidle-test-'));
    const opened: string[] = [];
    const shownInFolder: string[] = [];
    const openedUrls: string[] = [];
    const downloads = new Map<string, { status?: number; contentType?: string; bytes: Uint8Array }>();
    const host: Host = {
        platform: 'linux',
        appVersion: 'test',
        dataDirectory,
        files: nodeFiles,
        openPath: (p) => opened.push(p),
        showItemInFolder: (p) => shownInFolder.push(p),
        openExternal: (url) => openedUrls.push(url),
        fetch: async (url) => {
            const download = downloads.get(url);

            if (!download) {
                throw new Error(`No fake download for ${url}`);
            }

            return {
                status: download.status ?? 200,
                contentType: download.contentType ?? null,
                bytes: download.bytes,
            };
        },
    };
    const workspaces = new Workspaces(host, openNodeDatabase);
    const context = createContext(host, workspaces, fileSettings(host));

    return {
        ...context,
        opened,
        shownInFolder,
        openedUrls,
        downloads,
        cleanup() {
            workspaces.close();
            fs.rmSync(dataDirectory, { recursive: true, force: true });
        },
    };
}

/** Builds a request for router tests. */
export function request(
    method: string,
    url: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
): AppRequest {
    return {
        method,
        url: new URL(url, 'yeidle://app'),
        headers: { accept: 'application/json', ...headers },
        body,
        files: {},
    };
}

/** Sends a request through a router and decodes a JSON response. */
export async function call(
    router: Router,
    method: string,
    url: string,
    body: Record<string, unknown> = {},
    headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string>; json: any; response: AppResponse }> {
    const response = await router.handle(request(method, url, body, headers));
    const text =
        typeof response.body === 'string'
            ? response.body
            : response.body instanceof Uint8Array
              ? new TextDecoder().decode(response.body)
              : '';
    let parsed: unknown = null;

    try {
        parsed = text === '' ? null : JSON.parse(text);
    } catch {
        parsed = text;
    }

    return { status: response.status, headers: response.headers, json: parsed, response };
}

/** A RequestContext for calling handlers directly. */
export function contextFor(body: Record<string, unknown> = {}, url = 'yeidle://app/'): RequestContext {
    const req = request('GET', url, body);

    return {
        request: req,
        params: {},
        query: new Input(Object.fromEntries(req.url.searchParams)),
        input: new Input(body),
        file: () => null,
    };
}

export { Router };
