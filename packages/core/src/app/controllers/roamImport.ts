import {
    abort,
    empty,
    HttpError,
    invalid,
    json,
    stream,
} from '../../http/http';
import type { Input } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid, uuidv7 } from '../../support/ids';
import type { AppContext } from '../context';
import { RoamExport } from '../import/roam/export';
import { RoamImporter } from '../import/roam/importer';
import type { RoamProgress } from '../import/roam/importer';
import { RoamImportCancelled, RoamImportError } from '../import/roam/report';
import { WorkspaceError } from '../workspaces';
import type { Workspace, WorkspaceRecord } from '../workspaces';

const CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 1280 * 1024;
const MAX_EXPORT_BYTES = 512 * 1024 * 1024;
const UPLOAD_LIFETIME_MS = 24 * 60 * 60 * 1000;
const GENERIC_ERROR = 'The Roam database could not be imported.';

type UploadMeta = {
    filename: string;
    size: number;
    total_chunks: number;
    created_at: string;
};

type ImportRequest = {
    upload_id: string;
    workspace_id: string | null;
    new_workspace_name: string | null;
    download_attachments: boolean;
};

export type ImportResult = {
    workspace: WorkspaceRecord;
    report: Record<string, number>;
    warnings: string[];
    has_failures: boolean;
};

/**
 * The import dialog's endpoints: the export is uploaded in 1 MB chunks
 * (init → chunk… → stream or finish), then imported into an existing
 * workspace or a new one. Importing never changes the active workspace.
 */
export function registerRoamImportRoutes(
    router: Router,
    ctx: AppContext,
): void {
    const files = ctx.host.files;
    const root = files.join(ctx.host.dataDirectory, 'roam-imports');
    const uploadDirectory = (uploadId: string) => files.join(root, uploadId);

    const readMetadata = (directory: string): UploadMeta => {
        let meta: Partial<UploadMeta> | null;

        try {
            meta = JSON.parse(
                files.readText(files.join(directory, 'meta.json')),
            );
        } catch {
            throw new RoamImportError('The Roam upload metadata is invalid.');
        }

        if (
            typeof meta?.filename !== 'string' ||
            !Number.isInteger(meta.size) ||
            !Number.isInteger(meta.total_chunks) ||
            typeof meta.created_at !== 'string'
        ) {
            throw new RoamImportError('The Roam upload metadata is invalid.');
        }

        return meta as UploadMeta;
    };

    const existingUploadDirectory = (uploadId: string): string => {
        const directory = uploadDirectory(uploadId);

        if (!files.isFile(files.join(directory, 'meta.json'))) {
            abort(404, 'Roam upload not found.');
        }

        return directory;
    };

    const deleteExpiredUploads = () => {
        for (const name of files.list(root)) {
            const directory = files.join(root, name);

            if (!files.isDirectory(directory)) {
                continue;
            }

            let createdAt = Number.NaN;

            try {
                createdAt = Date.parse(readMetadata(directory).created_at);
            } catch {
                // Without metadata the upload can't be finished anyway
            }

            if (
                Number.isNaN(createdAt) ||
                createdAt < Date.now() - UPLOAD_LIFETIME_MS
            ) {
                files.removeDirectory(directory);
            }
        }
    };

    const assembleExport = (directory: string): string => {
        const meta = readMetadata(directory);
        const exportPath = files.join(directory, 'export.json');
        files.writeFile(exportPath, new Uint8Array());
        let bytesWritten = 0;

        for (let index = 0; index < meta.total_chunks; index++) {
            const chunkPath = files.join(directory, `chunk_${index}`);

            if (!files.isFile(chunkPath)) {
                throw new RoamImportError(
                    `Roam export chunk ${index} is missing.`,
                );
            }

            const chunk = files.readFile(chunkPath);
            files.appendFile(exportPath, chunk);
            bytesWritten += chunk.byteLength;
        }

        if (bytesWritten !== meta.size) {
            throw new RoamImportError(
                'The uploaded Roam export has an unexpected size.',
            );
        }

        return exportPath;
    };

    const runImport = async (
        request: ImportRequest,
        progress: RoamProgress | null = null,
    ) => {
        const directory = existingUploadDirectory(request.upload_id);
        let workspace: WorkspaceRecord | null = null;
        let target: { context: AppContext; close(): void } | null = null;
        const createdWorkspace = request.workspace_id === null;

        try {
            const exportPath = assembleExport(directory);

            // Validate the complete export before creating a destination so a
            // malformed file cannot leave an empty workspace behind
            RoamExport.fromPath(files, exportPath, 'validation');

            workspace =
                request.workspace_id !== null
                    ? ctx.workspaces.find(request.workspace_id)
                    : ctx.workspaces.create(request.new_workspace_name!);
            target = workspaceContext(ctx, workspace);

            const report = await new RoamImporter(target.context).import(
                exportPath,
                {
                    downloadAttachments: request.download_attachments,
                    workspaceId: workspace.id,
                    progress,
                },
            );

            return {
                workspace,
                report: report.summary(),
                warnings: report.warnings,
                has_failures: report.hasFailures(),
            } satisfies ImportResult;
        } catch (error) {
            if (
                error instanceof RoamImportCancelled &&
                createdWorkspace &&
                workspace !== null
            ) {
                target?.close();
                target = null;
                ctx.workspaces.delete(workspace.id);
            }

            throw error;
        } finally {
            target?.close();
            files.removeDirectory(directory);
        }
    };

    router.post('/api/imports/roam/init', ({ input }) => {
        const filename = input.string('filename', { max: 255 });

        if (!/\.json$/i.test(filename)) {
            invalid('filename', 'The filename field format is invalid.');
        }

        const size = input.integer('size', { min: 2, max: MAX_EXPORT_BYTES });
        const totalChunks = Math.ceil(size / CHUNK_BYTES);

        deleteExpiredUploads();

        const uploadId = uuidv7();
        const directory = uploadDirectory(uploadId);
        files.mkdir(directory);
        files.writeFile(
            files.join(directory, 'meta.json'),
            JSON.stringify({
                filename: filename.split(/[\\/]/).pop(),
                size,
                total_chunks: totalChunks,
                created_at: new Date().toISOString(),
            }),
        );

        return json(
            {
                upload_id: uploadId,
                chunk_size: CHUNK_BYTES,
                total_chunks: totalChunks,
            },
            201,
        );
    });

    router.post('/api/imports/roam/chunk', ({ input, file }) => {
        const uploadId = uuidInput(input, 'upload_id');
        const index = input.integer('chunk_index', { min: 0 });
        const chunk = file('chunk');

        if (chunk === null) {
            invalid('chunk', 'The chunk field is required.');
        }

        if (chunk.bytes.byteLength > MAX_CHUNK_BYTES) {
            invalid(
                'chunk',
                'The chunk field must not be greater than 1280 kilobytes.',
            );
        }

        const directory = existingUploadDirectory(uploadId);
        const meta = readMetadata(directory);

        if (index >= meta.total_chunks) {
            invalid('chunk_index', 'The Roam export chunk index is invalid.');
        }

        const expectedSize =
            index === meta.total_chunks - 1
                ? meta.size - index * CHUNK_BYTES
                : CHUNK_BYTES;
        const receivedSize = chunk.bytes.byteLength;

        if (receivedSize !== expectedSize) {
            invalid(
                'chunk',
                `The Roam export chunk has an unexpected size (${receivedSize} received; ${expectedSize} expected).`,
            );
        }

        files.writeFile(files.join(directory, `chunk_${index}`), chunk.bytes);

        return json({ received: index });
    });

    router.post('/api/imports/roam/finish', async ({ input }) => {
        const request = validateImport(input);

        try {
            return json(await runImport(request));
        } catch (error) {
            return json({ message: errorMessage(error) }, 422);
        }
    });

    router.post('/api/imports/roam/stream', ({ input }) => {
        const request = validateImport(input);

        return stream(
            eventStream(async (emit, cancelled) => {
                try {
                    await emit({
                        type: 'progress',
                        phase: 'preparing',
                        current: 0,
                        total: 0,
                    });

                    const result = await runImport(
                        request,
                        (phase, current, total) =>
                            emit({ type: 'progress', phase, current, total }),
                    );

                    await emit({ type: 'complete', result });
                } catch (error) {
                    // A closed stream is a deliberate stop; runImport has
                    // already removed an incomplete newly-created workspace
                    if (
                        !(error instanceof RoamImportCancelled) &&
                        !cancelled()
                    ) {
                        await emit({
                            type: 'error',
                            message: errorMessage(error),
                        }).catch(() => {});
                    }
                }
            }),
        );
    });

    router.delete('/api/imports/roam/{uploadId}', ({ params }) => {
        if (isUuid(params.uploadId)) {
            files.removeDirectory(uploadDirectory(params.uploadId));
        }

        return empty(204);
    });
}

function uuidInput(input: Input, key: string): string {
    const value = input.string(key);

    if (!isUuid(value)) {
        invalid(
            key,
            `The ${key.replaceAll('_', ' ')} field must be a valid UUID.`,
        );
    }

    return value;
}

function validateImport(input: Input): ImportRequest {
    const uploadId = uuidInput(input, 'upload_id');
    const workspaceId = input.optionalString('workspace_id');

    if (workspaceId !== null && !isUuid(workspaceId)) {
        invalid('workspace_id', 'The workspace id field must be a valid UUID.');
    }

    const name = input.optionalString('new_workspace_name');

    if (name !== null && name.length > 100) {
        invalid(
            'new_workspace_name',
            'The new workspace name field must not be greater than 100 characters.',
        );
    }

    if (
        !input.has('download_attachments') ||
        input.raw('download_attachments') === null
    ) {
        invalid(
            'download_attachments',
            'The download attachments field is required.',
        );
    }

    const downloadAttachments = input.boolean('download_attachments');
    const newWorkspaceName = (name ?? '').trim();

    if ((workspaceId === null) === (newWorkspaceName === '')) {
        invalid(
            'workspace',
            'Choose an existing workspace or enter a new workspace name.',
        );
    }

    return {
        upload_id: uploadId,
        workspace_id: workspaceId,
        new_workspace_name: newWorkspaceName !== '' ? newWorkspaceName : null,
        download_attachments: downloadAttachments,
    };
}

function errorMessage(error: unknown): string {
    if (
        error instanceof RoamImportError ||
        error instanceof HttpError ||
        error instanceof WorkspaceError
    ) {
        return error.message;
    }

    console.error(error);

    return GENERIC_ERROR;
}

/**
 * The context the import writes through. The active workspace is used as
 * is; any other workspace is opened separately for the import's duration,
 * the way the PHP controller pointed only its own request's connection at
 * the target. The active workspace (and every other request) is untouched.
 */
function workspaceContext(
    ctx: AppContext,
    record: WorkspaceRecord,
): { context: AppContext; close(): void } {
    const bound = (workspace: Workspace): AppContext => ({
        ...ctx,
        workspace: () => workspace,
        db: () => workspace.db,
        documents: () => workspace.documents,
    });

    // Bound to the workspace itself so a switch mid-import can't redirect writes
    if (ctx.workspace().id === record.id) {
        return { context: bound(ctx.workspace()), close: () => {} };
    }

    const workspace = ctx.workspaces.openDetached(record.id);
    let closed = false;

    return {
        context: bound(workspace),
        close: () => {
            if (!closed) {
                closed = true;
                workspace.db.close();
            }
        },
    };
}

type Emit = (event: Record<string, unknown>) => Promise<void>;

/**
 * NDJSON lines produced by `run`. Each emit yields to the event loop so the
 * host can send the line; once the client closes the stream, the next emit
 * throws RoamImportCancelled, which stops the import between batches.
 */
function eventStream(
    run: (emit: Emit, cancelled: () => boolean) => Promise<void>,
): AsyncIterable<string> {
    const queue: string[] = [];
    let started = false;
    let finished = false;
    let cancelled = false;
    let wake: (() => void) | null = null;

    const notify = () => {
        wake?.();
        wake = null;
    };

    const emit: Emit = async (event) => {
        if (cancelled) {
            throw new RoamImportCancelled();
        }

        queue.push(`${JSON.stringify(event)}\n`);
        notify();
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (cancelled) {
            throw new RoamImportCancelled();
        }
    };

    const start = () => {
        if (started) {
            return;
        }

        started = true;
        run(emit, () => cancelled)
            .catch((error) => console.error(error))
            .finally(() => {
                finished = true;
                notify();
            });
    };

    return {
        [Symbol.asyncIterator]: () => ({
            async next(): Promise<IteratorResult<string>> {
                start();

                while (queue.length === 0 && !finished && !cancelled) {
                    await new Promise<void>((resolve) => (wake = resolve));
                }

                if (queue.length > 0 && !cancelled) {
                    return { value: queue.shift()!, done: false };
                }

                return { value: undefined, done: true };
            },
            async return(): Promise<IteratorResult<string>> {
                cancelled = true;
                queue.length = 0;
                notify();

                return { value: undefined, done: true };
            },
        }),
    };
}
