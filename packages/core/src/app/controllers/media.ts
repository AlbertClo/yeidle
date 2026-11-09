import { createHash, randomUUID } from 'node:crypto';

import { abort, file, invalid, json } from '../../http/http';
import type { Input } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid, uuidv7 } from '../../support/ids';
import { jsonTimestamp } from '../../support/time';
import type { AppContext } from '../context';

/**
 * Chunked uploads and content-addressed blobs: `<storage>/media/<sha256>`,
 * no extension, shared by every media row with the same content. Metadata
 * goes through the media document; the blob never does.
 */

type UploadMeta = {
    filename: string;
    size: number;
    mime_type: string;
    total_chunks: number;
    received_chunks: number;
};

type MediaRecord = {
    id: string;
    filename: string;
    original_name: string;
    mime_type: string;
    size: number;
    created_at: string | null;
    updated_at: string | null;
    cloud_uploaded_at: string | null;
};

export function registerMediaRoutes(router: Router, ctx: AppContext): void {
    const files = ctx.host.files;
    const storage = (...parts: string[]) => files.join(ctx.workspace().storagePath, ...parts);
    const uploadDirectory = (uploadId: string) => storage('uploads', uploadId);
    const metaPath = (uploadId: string) => files.join(uploadDirectory(uploadId), 'meta.json');

    // Upload ids are UUIDs we minted; anything else can't name an upload (and mustn't name a path)
    const findUpload = (uploadId: string): UploadMeta | null =>
        isUuid(uploadId) && files.isFile(metaPath(uploadId))
            ? (JSON.parse(files.readText(metaPath(uploadId))) as UploadMeta)
            : null;

    const findMedia = (id: string): MediaRecord => {
        const media = ctx.db().get<MediaRecord>('SELECT * FROM media WHERE id = ?', [id]);

        if (!media) {
            abort(404, `No query results for model [App\\Models\\Media] ${id}`);
        }

        return media;
    };

    /**
     * The PHP app downloaded missing blobs from the cloud here
     * (CloudBlobService::localPath). Cloud blobs aren't ported yet.
     */
    const localBlob = (media: MediaRecord): string => {
        const path = storage('media', media.filename);

        if (!/^[0-9a-f]{64}$/.test(media.filename) || !files.isFile(path)) {
            abort(503, 'Media is not currently available on this device.');
        }

        return path;
    };

    router.post('/api/media/init', ({ input }) => {
        const filename = requiredString(input, 'filename');
        const size = requiredInteger(input, 'size', 1);
        const mimeType = requiredString(input, 'mime_type');
        const totalChunks = requiredInteger(input, 'total_chunks', 1);

        const uploadId = randomUUID();
        files.mkdir(uploadDirectory(uploadId));
        writeMeta(uploadId, {
            filename,
            size,
            mime_type: mimeType,
            total_chunks: totalChunks,
            received_chunks: 0,
        });

        return json({ upload_id: uploadId }, 201);
    });

    router.post('/api/media/chunk', ({ input, file: upload }) => {
        const uploadId = requiredString(input, 'upload_id');
        const chunkIndex = requiredInteger(input, 'chunk_index', 0);
        const chunk = upload('chunk');

        if (chunk === null) {
            invalid('chunk', 'The chunk field is required.');
        }

        const meta = findUpload(uploadId);

        if (meta === null) {
            return json({ message: 'Upload not found' }, 404);
        }

        files.writeFile(files.join(uploadDirectory(uploadId), `chunk_${chunkIndex}`), chunk.bytes);
        meta.received_chunks++;
        writeMeta(uploadId, meta);

        return json({ received: meta.received_chunks }, 200);
    });

    router.post('/api/media/complete', ({ input }) => {
        const uploadId = requiredString(input, 'upload_id');
        const meta = findUpload(uploadId);

        if (meta === null) {
            return json({ message: 'Upload not found' }, 404);
        }

        const directory = uploadDirectory(uploadId);
        const assembled = files.join(directory, 'assembled');
        const hash = createHash('sha256');

        files.mkdir(storage('media'));
        files.writeFile(assembled, new Uint8Array());

        for (let i = 0; i < meta.total_chunks; i++) {
            const chunkPath = files.join(directory, `chunk_${i}`);

            if (!files.isFile(chunkPath)) {
                invalid('upload_id', `The upload is missing chunk ${i}.`);
            }

            const bytes = files.readFile(chunkPath);
            hash.update(bytes);
            files.appendFile(assembled, bytes);
        }

        const digest = hash.digest('hex');

        // Content-addressed: re-uploading identical content reuses the existing blob
        const blob = storage('media', digest);

        if (files.exists(blob)) {
            files.unlink(assembled);
        } else {
            files.rename(assembled, blob);
        }

        const mediaId = uuidv7();
        ctx.documents().applyChanges([
            {
                type: 'media.create',
                payload: {
                    id: mediaId,
                    hash: digest,
                    original_name: meta.filename,
                    mime_type: meta.mime_type,
                    size: meta.size,
                },
            },
        ]);

        files.removeDirectory(directory);

        return json(serializeMedia(findMedia(mediaId)), 201);
    });

    router.get('/api/media/{media}', ({ params }) => {
        const media = findMedia(params.media);

        return file(localBlob(media), media.mime_type, {
            'content-disposition': contentDisposition(media.original_name),
            'cache-control': 'public, max-age=31536000',
        });
    });

    router.post('/api/media/{media}/open', ({ params }) => {
        const media = findMedia(params.media);
        const blob = localBlob(media);

        // Blobs are extension-less content hashes; link them under the original
        // filename so the OS can pick the right application
        files.mkdir(storage('media-open'));
        const target = storage('media-open', `${media.id}-${files.basename(media.original_name)}`);

        if (!files.exists(target)) {
            files.link(blob, target);
        }

        ctx.host.openPath(target);

        return json(null, 200);
    });

    router.post('/api/media/{media}/open-folder', ({ params }) => {
        const media = findMedia(params.media);
        const blob = storage('media', media.filename);

        if (/^[0-9a-f]{64}$/.test(media.filename) && files.isFile(blob)) {
            ctx.host.showItemInFolder(blob);
        } else {
            files.mkdir(storage('media'));
            ctx.host.openPath(storage('media'));
        }

        return json(null, 200);
    });

    function writeMeta(uploadId: string, meta: UploadMeta): void {
        files.writeFile(metaPath(uploadId), JSON.stringify(meta));
    }
}

/** Eloquent's JSON for a Media row. */
export function serializeMedia(media: MediaRecord): Record<string, unknown> {
    return {
        id: media.id,
        filename: media.filename,
        original_name: media.original_name,
        mime_type: media.mime_type,
        size: Number(media.size),
        created_at: jsonTimestamp(media.created_at),
        updated_at: jsonTimestamp(media.updated_at),
        cloud_uploaded_at: jsonTimestamp(media.cloud_uploaded_at),
    };
}

/**
 * `inline; filename="<name>"` as the PHP app sent it. Header values must be
 * Latin-1 here, so other names get an ASCII fallback plus RFC 5987 filename*.
 */
function contentDisposition(name: string): string {
    if (/^[\x20-\x7e]*$/.test(name) && !/["\\]/.test(name)) {
        return `inline; filename="${name}"`;
    }

    const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');

    return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function requiredString(input: Input, key: string): string {
    const value = input.raw(key);

    if (value === undefined || value === null || value === '') {
        invalid(key, `The ${key} field is required.`);
    }

    if (typeof value !== 'string') {
        invalid(key, `The ${key} field must be a string.`);
    }

    return value;
}

function requiredInteger(input: Input, key: string, min: number): number {
    const value = input.raw(key);

    if (value === undefined || value === null || value === '') {
        invalid(key, `The ${key} field is required.`);
    }

    return input.integer(key, { min });
}
