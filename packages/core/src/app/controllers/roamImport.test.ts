import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RoamImporter } from '../import/roam/importer';

import { call, request, Router, testContext } from '../testing';

import { registerRoamImportRoutes } from './roamImport';

const fixture = fileURLToPath(
    new URL('../import/roam/fixtures/roam-export.json', import.meta.url),
);

let ctx: ReturnType<typeof testContext>;
let router: Router;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    registerRoamImportRoutes(router, ctx);
});

afterEach(() => ctx.cleanup());

async function upload(content: string): Promise<string> {
    const bytes = new TextEncoder().encode(content);
    const init = await call(router, 'POST', '/api/imports/roam/init', {
        filename: 'roam-export.json',
        size: bytes.byteLength,
    });
    expect(init.status).toBe(201);
    const {
        upload_id: uploadId,
        chunk_size: chunkSize,
        total_chunks: totalChunks,
    } = init.json;

    for (let index = 0; index < totalChunks; index++) {
        const req = request('POST', '/api/imports/roam/chunk', {
            upload_id: uploadId,
            // Multipart form fields arrive as strings
            chunk_index: String(index),
        });
        req.files.chunk = {
            name: `chunk_${index}`,
            type: 'application/octet-stream',
            bytes: bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
        };
        const response = await router.handle(req);
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body as string)).toEqual({
            received: index,
        });
    }

    return uploadId;
}

async function streamEvents(body: Record<string, unknown>): Promise<any[]> {
    const response = await router.handle(
        request('POST', '/api/imports/roam/stream', body),
    );
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-ndjson');
    let text = '';

    for await (const chunk of (
        response.body as { stream: AsyncIterable<string> }
    ).stream) {
        text += chunk;
    }

    return text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
}

function countIn(workspaceId: string, sql: string): number {
    const previous = ctx.workspaces.state().active_workspace_id;
    ctx.workspaces.activate(workspaceId);

    try {
        return ctx.db().get<{ count: number }>(sql)!.count;
    } finally {
        ctx.workspaces.activate(previous);
    }
}

/** Imported pages and blocks. */
const NODES =
    'SELECT (SELECT COUNT(*) FROM pages) + (SELECT COUNT(*) FROM blocks) AS count';

describe('Roam import API', () => {
    it('imports into a new workspace without activating it', async () => {
        const initialActive = ctx.workspaces.state().active_workspace_id;
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));

        const response = await call(
            router,
            'POST',
            '/api/imports/roam/finish',
            {
                upload_id: uploadId,
                workspace_id: null,
                new_workspace_name: 'Imported Roam',
                download_attachments: false,
            },
        );

        expect(response.status).toBe(200);
        expect(response.json.workspace.name).toBe('Imported Roam');
        expect(response.json.report.Pages).toBe(2);
        expect(response.json.report.Blocks).toBe(5);
        expect(response.json.has_failures).toBe(false);
        expect(ctx.workspaces.state().active_workspace_id).toBe(initialActive);
        expect(ctx.workspaces.all()).toHaveLength(2);
        expect(ctx.db().get<{ count: number }>(NODES)!.count).toBe(0);
        expect(countIn(response.json.workspace.id, NODES)).toBe(7);
        expect(
            countIn(
                response.json.workspace.id,
                'SELECT COUNT(*) AS count FROM media',
            ),
        ).toBe(0);
        expect(
            fs.existsSync(ctx.workspaces.databasePath(response.json.workspace)),
        ).toBe(true);
        // The upload is cleaned up
        expect(
            fs.existsSync(`${ctx.host.dataDirectory}/roam-imports/${uploadId}`),
        ).toBe(false);
    });

    it('merges an import into an existing workspace', async () => {
        const workspace = ctx.workspaces.create('Existing');
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));

        const response = await call(
            router,
            'POST',
            '/api/imports/roam/finish',
            {
                upload_id: uploadId,
                workspace_id: workspace.id,
                new_workspace_name: null,
                download_attachments: false,
            },
        );

        expect(response.status).toBe(200);
        expect(response.json.workspace.id).toBe(workspace.id);
        expect(response.json.report['Nodes written']).toBe(7);
        expect(countIn(workspace.id, NODES)).toBe(7);
        expect(ctx.workspaces.all()).toHaveLength(2);
    });

    it('imports into the active workspace', async () => {
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));

        const response = await call(
            router,
            'POST',
            '/api/imports/roam/finish',
            {
                upload_id: uploadId,
                workspace_id: ctx.workspace().id,
                download_attachments: false,
            },
        );

        expect(response.status).toBe(200);
        expect(ctx.db().get<{ count: number }>(NODES)!.count).toBe(7);
    });

    it('streams preparation, node progress and completion', async () => {
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));

        const events = await streamEvents({
            upload_id: uploadId,
            workspace_id: null,
            new_workspace_name: 'Streamed Roam',
            download_attachments: false,
        });

        expect(events[0]).toEqual({
            type: 'progress',
            phase: 'preparing',
            current: 0,
            total: 0,
        });
        expect(events).toContainEqual({
            type: 'progress',
            phase: 'nodes',
            current: 0,
            total: 7,
        });
        expect(events).toContainEqual({
            type: 'progress',
            phase: 'nodes',
            current: 7,
            total: 7,
        });
        expect(events.at(-1).type).toBe('complete');
        expect(events.at(-1).result.report['Nodes written']).toBe(7);
    });

    it('streams errors as events', async () => {
        const uploadId = await upload('[{"uid": "x"}]');

        const events = await streamEvents({
            upload_id: uploadId,
            new_workspace_name: 'Broken',
            download_attachments: false,
        });

        expect(events.at(-1)).toEqual({
            type: 'error',
            message: 'Roam page [x] is missing a string [title].',
        });
        expect(ctx.workspaces.all()).toHaveLength(1);
    });

    it('removes the new workspace when the import fails part-way', async () => {
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));
        vi.spyOn(RoamImporter.prototype, 'import').mockRejectedValueOnce(
            new Error('disk full'),
        );

        const events = await streamEvents({
            upload_id: uploadId,
            new_workspace_name: 'Half done',
            download_attachments: false,
        });

        expect(events.at(-1)).toMatchObject({ type: 'error' });
        expect(ctx.workspaces.all().map((w) => w.name)).not.toContain(
            'Half done',
        );
        vi.restoreAllMocks();
    });

    it('removes the new workspace when the stream is closed mid-import', async () => {
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));
        const response = await router.handle(
            request('POST', '/api/imports/roam/stream', {
                upload_id: uploadId,
                new_workspace_name: 'Stopped',
                download_attachments: false,
            }),
        );
        const iterator = (
            response.body as { stream: AsyncIterable<string> }
        ).stream[Symbol.asyncIterator]();

        for (;;) {
            const { value } = await iterator.next();

            if (JSON.parse(value).phase === 'nodes') {
                break;
            }
        }

        expect(ctx.workspaces.all()).toHaveLength(2);
        await iterator.return!();

        for (let i = 0; i < 20 && ctx.workspaces.all().length > 1; i++) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        expect(ctx.workspaces.all()).toHaveLength(1);
    });

    it('does not create a workspace for an invalid export', async () => {
        const uploadId = await upload('{not valid json');

        const response = await call(
            router,
            'POST',
            '/api/imports/roam/finish',
            {
                upload_id: uploadId,
                workspace_id: null,
                new_workspace_name: 'Should Not Exist',
                download_attachments: false,
            },
        );

        expect(response.status).toBe(422);
        expect(response.json.message).toContain('not valid JSON');
        expect(ctx.workspaces.all()).toHaveLength(1);
    });

    it('requires exactly one destination', async () => {
        const uploadId = await upload(fs.readFileSync(fixture, 'utf8'));

        const response = await call(
            router,
            'POST',
            '/api/imports/roam/finish',
            {
                upload_id: uploadId,
                workspace_id: ctx.workspace().id,
                new_workspace_name: 'Both',
                download_attachments: false,
            },
        );

        expect(response.status).toBe(422);
        expect(response.json.errors.workspace).toEqual([
            'Choose an existing workspace or enter a new workspace name.',
        ]);
    });

    it('chunks exports larger than one chunk and cancels uploads', async () => {
        const content =
            fs.readFileSync(fixture, 'utf8') + ' '.repeat(2 * 1024 * 1024 + 1);
        const uploadId = await upload(content);
        expect(
            fs.readdirSync(
                `${ctx.host.dataDirectory}/roam-imports/${uploadId}`,
            ),
        ).toHaveLength(4);

        const response = await call(
            router,
            'DELETE',
            `/api/imports/roam/${uploadId}`,
        );

        expect(response.status).toBe(204);
        expect(
            fs.existsSync(`${ctx.host.dataDirectory}/roam-imports/${uploadId}`),
        ).toBe(false);
    });

    it('rejects chunks of the wrong size', async () => {
        const init = await call(router, 'POST', '/api/imports/roam/init', {
            filename: 'export.json',
            size: 10,
        });
        const req = request('POST', '/api/imports/roam/chunk', {
            upload_id: init.json.upload_id,
            chunk_index: '0',
        });
        req.files.chunk = {
            name: 'chunk_0',
            type: 'application/octet-stream',
            bytes: new Uint8Array(4),
        };

        const response = await router.handle(req);

        expect(response.status).toBe(422);
        expect(JSON.parse(response.body as string).errors.chunk[0]).toContain(
            '4 received; 10 expected',
        );
    });

    it('validates the export file name', async () => {
        const response = await call(router, 'POST', '/api/imports/roam/init', {
            filename: 'export.zip',
            size: 10,
        });

        expect(response.status).toBe(422);
        expect(response.json.errors.filename).toBeDefined();
    });
});
