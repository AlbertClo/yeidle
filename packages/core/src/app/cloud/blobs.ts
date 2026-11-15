import { createHash } from 'node:crypto';

import type { Database } from '../../db/database';
import { uuidv7 } from '../../support/ids';
import { sqlTimestamp } from '../../support/time';
import type { Files } from '../host';

import { CloudError, cloudMessage, cloudRequest } from './http';
import type { CloudFetch } from './http';

/**
 * Media files ("blobs") between this device and the cloud's object storage.
 * Media metadata syncs in the Loro media document; the files themselves are
 * content-addressed (`<storage>/media/<sha256>`) and travel separately, via
 * short-lived presigned URLs straight to and from storage:
 *
 *   upload:   local files whose media rows have no cloud_uploaded_at
 *             (HEAD first; storage verifies the SHA-256 on PUT)
 *   download: when a file is shown and missing here, and in the background
 *             after a pull so files are available offline
 *
 * This runs beside note sync, never inside it: a large upload doesn't hold
 * back text, and a file that hasn't arrived yet just isn't shown yet.
 */

export type BlobConnection = {
    url: string;
    token: string;
    workspaceId: string;
};

const HASH = /^[0-9a-f]{64}$/;
const TRANSFER_TIMEOUT_MS = 10 * 60_000;

export class CloudBlobs {
    private running: Promise<void> | null = null;
    private again = false;
    private downloads = new Map<string, Promise<string>>();

    constructor(
        private db: Database,
        private files: Files,
        private mediaDirectory: string,
        private fetchImpl: CloudFetch,
        private connection: () => BlobConnection | null,
    ) {}

    /** Distinct local files the cloud hasn't confirmed yet. */
    pendingUploadCount(): number {
        return this.pendingHashes().length;
    }

    /**
     * Uploads pending files, then downloads missing ones. Concurrent calls
     * share the running pass; calls during it schedule exactly one more.
     */
    run(): Promise<void> {
        if (this.running) {
            this.again = true;

            return this.running;
        }

        this.running = (async () => {
            do {
                this.again = false;

                if (this.connection() === null) {
                    return;
                }

                await this.uploadPending().catch(() => undefined);
                await this.downloadMissing().catch(() => undefined);
            } while (this.again);
        })().finally(() => {
            this.running = null;
        });

        return this.running;
    }

    async uploadPending(): Promise<number> {
        const connection = this.requireConnection();
        let uploaded = 0;

        for (const { hash, mime_type, size } of this.pendingHashes()) {
            const exists = await cloudRequest(
                this.fetchImpl,
                'HEAD',
                this.blobUrl(connection, hash),
                { token: connection.token },
            );

            if (exists.ok) {
                this.markUploaded(hash);
                continue;
            }

            if (exists.status !== 404) {
                throw new CloudError(
                    `Could not check a media file (HTTP ${exists.status}).`,
                    exists.status,
                );
            }

            const ticket = await cloudRequest(
                this.fetchImpl,
                'POST',
                this.blobUrl(connection, hash, '/upload-url'),
                {
                    token: connection.token,
                    json: {
                        mime_type: mime_type || 'application/octet-stream',
                        size,
                    },
                },
            );

            if (!ticket.ok) {
                throw new CloudError(
                    cloudMessage(ticket, 'Could not start a media upload'),
                    ticket.status,
                );
            }

            if (ticket.body?.exists !== true) {
                const url = ticket.body?.url;
                const headers = ticket.body?.headers;

                if (
                    typeof url !== 'string' ||
                    url === '' ||
                    !isHeaders(headers)
                ) {
                    throw new CloudError(
                        'Yeidle Cloud returned an invalid upload ticket.',
                    );
                }

                const bytes = this.files.readFile(this.path(hash));
                let response: Response;

                try {
                    response = await this.fetchImpl(url, {
                        method: 'PUT',
                        headers: transferHeaders(headers),
                        body: bytes as Uint8Array<ArrayBuffer>,
                        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
                    });
                } catch {
                    throw new CloudError('Could not upload a media file.');
                }

                if (!response.ok) {
                    throw new CloudError(
                        `Storage refused a media file (HTTP ${response.status}).`,
                        response.status,
                    );
                }
            }

            this.markUploaded(hash);
            uploaded++;
        }

        return uploaded;
    }

    /** Downloads every file this workspace references but doesn't have. */
    async downloadMissing(): Promise<number> {
        let downloaded = 0;
        const hashes = this.db
            .all<{ filename: string }>('SELECT DISTINCT filename FROM media')
            .map((row) => row.filename)
            .filter(
                (hash) =>
                    HASH.test(hash) && !this.files.isFile(this.path(hash)),
            );

        for (const hash of hashes) {
            try {
                await this.ensureLocal(hash);
                downloaded++;
            } catch (error) {
                // Not uploaded by its device yet: a later pass gets it
                if (!(error instanceof CloudError && error.status === 404)) {
                    throw error;
                }
            }
        }

        return downloaded;
    }

    /**
     * The local path of a file, downloading it first if needed. Concurrent
     * requests for the same file share one download.
     */
    ensureLocal(hash: string): Promise<string> {
        if (!HASH.test(hash)) {
            return Promise.reject(
                new CloudError('The media file name is invalid.'),
            );
        }

        if (this.files.isFile(this.path(hash))) {
            return Promise.resolve(this.path(hash));
        }

        let download = this.downloads.get(hash);

        if (!download) {
            download = this.download(hash).finally(() =>
                this.downloads.delete(hash),
            );
            this.downloads.set(hash, download);
        }

        return download;
    }

    private async download(hash: string): Promise<string> {
        const connection = this.requireConnection();
        const ticket = await cloudRequest(
            this.fetchImpl,
            'GET',
            this.blobUrl(connection, hash, '/download-url'),
            { token: connection.token },
        );

        if (!ticket.ok || typeof ticket.body?.url !== 'string') {
            throw new CloudError(
                ticket.status === 404
                    ? 'This file has not been uploaded from its device yet.'
                    : cloudMessage(ticket, 'Could not download a media file'),
                ticket.status,
            );
        }

        let response: Response;

        try {
            response = await this.fetchImpl(ticket.body.url, {
                signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
            });
        } catch {
            throw new CloudError('Could not download a media file.');
        }

        if (!response.ok) {
            throw new CloudError(
                `Storage refused a media download (HTTP ${response.status}).`,
                response.status,
            );
        }

        const bytes = new Uint8Array(await response.arrayBuffer());

        if (createHash('sha256').update(bytes).digest('hex') !== hash) {
            throw new CloudError(
                'A downloaded media file failed verification.',
            );
        }

        // Write aside and rename so a partial file never looks complete
        const target = this.path(hash);
        const temporary = this.files.join(
            this.mediaDirectory,
            `.${hash}.${uuidv7()}.tmp`,
        );
        this.files.mkdir(this.mediaDirectory);
        this.files.writeFile(temporary, bytes);

        if (this.files.isFile(target)) {
            this.files.unlink(temporary);
        } else {
            this.files.rename(temporary, target);
        }

        // It came from the cloud, so the cloud has it
        this.markUploaded(hash);

        return target;
    }

    private pendingHashes(): {
        hash: string;
        mime_type: string;
        size: number;
    }[] {
        return this.db
            .all<{ filename: string; mime_type: string; size: number }>(
                `SELECT filename, MIN(mime_type) AS mime_type, MIN(size) AS size
                 FROM media WHERE cloud_uploaded_at IS NULL GROUP BY filename`,
            )
            .filter(
                (row) =>
                    HASH.test(row.filename) &&
                    this.files.isFile(this.path(row.filename)),
            )
            .map((row) => ({
                hash: row.filename,
                mime_type: row.mime_type,
                size: Number(row.size),
            }));
    }

    private markUploaded(hash: string): void {
        this.db.run(
            'UPDATE media SET cloud_uploaded_at = ? WHERE filename = ? AND cloud_uploaded_at IS NULL',
            [sqlTimestamp(), hash],
        );
    }

    private requireConnection(): BlobConnection {
        const connection = this.connection();

        if (connection === null) {
            throw new CloudError('Cloud sync is not configured.');
        }

        return connection;
    }

    private blobUrl(
        connection: BlobConnection,
        hash: string,
        suffix = '',
    ): string {
        return `${connection.url}/api/workspaces/${connection.workspaceId}/blobs/${hash}${suffix}`;
    }

    private path(hash: string): string {
        return this.files.join(this.mediaDirectory, hash);
    }
}

function isHeaders(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The signed headers from the upload ticket. fetch sets Host and
 * Content-Length itself (to the same values) and rejects them as input.
 */
function transferHeaders(
    headers: Record<string, unknown>,
): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();

        if (lower === 'host' || lower === 'content-length') {
            continue;
        }

        result[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }

    return result;
}
