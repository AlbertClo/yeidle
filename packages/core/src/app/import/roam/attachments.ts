import { uuidv7 } from '../../../support/ids';
import type { AppContext } from '../../context';
import type { Host } from '../../host';

import { basename, rawUrlDecode, urlPath } from './contentConverter';
import type { MediaDescriptor } from './contentConverter';
import { RoamExport } from './export';
import { RoamImportCancelled, RoamImportError } from './report';
import type { RoamImportReport } from './report';

export type Download = {
    bytes: Uint8Array;
    mime_type: string | null;
    size: number;
};

/** Downloads one Roam upload, retrying once like the PHP importer did. */
export class RoamAttachmentFetcher {
    constructor(
        private host: Host,
        private retryDelayMs = 500,
    ) {}

    async fetch(url: string, maximumBytes: number): Promise<Download> {
        let response: Awaited<ReturnType<Host['fetch']>> | null = null;
        let failure: unknown = null;

        for (let attempt = 1; attempt <= 2; attempt++) {
            if (attempt > 1 && this.retryDelayMs > 0) {
                await new Promise((resolve) =>
                    setTimeout(resolve, this.retryDelayMs),
                );
            }

            try {
                response = await this.host.fetch(url);
                failure = null;

                if (response.status >= 200 && response.status < 300) {
                    break;
                }
            } catch (error) {
                response = null;
                failure = error;
            }
        }

        if (response === null) {
            throw failure instanceof Error
                ? failure
                : new RoamImportError('Download failed.');
        }

        if (response.status < 200 || response.status >= 300) {
            throw new RoamImportError(
                `Download returned HTTP ${response.status}.`,
            );
        }

        const size = response.bytes.byteLength;

        if (size < 1) {
            throw new RoamImportError('Download did not produce a file.');
        }

        if (size > maximumBytes) {
            throw new RoamImportError(
                'Download exceeds the configured maximum attachment size.',
            );
        }

        const mimeType = response.contentType?.split(';')[0].trim() ?? '';

        return {
            bytes: response.bytes,
            mime_type: mimeType !== '' ? mimeType : null,
            size,
        };
    }
}

type MediaRow = {
    id: string;
    filename: string;
    original_name: string;
    mime_type: string;
    size: number;
};

/**
 * Copies Roam's Firebase uploads into content-addressed local media. Media
 * ids derive from the URL without its query (the token rotates), so a
 * repeated import reuses what it downloaded before.
 */
export class RoamAttachmentImporter {
    constructor(
        private ctx: AppContext,
        private fetcher: RoamAttachmentFetcher = new RoamAttachmentFetcher(
            ctx.host,
        ),
    ) {}

    async import(
        urls: string[],
        report: RoamImportReport,
        workspaceId = 'default',
        progress:
            | ((current: number, total: number) => void | Promise<void>)
            | null = null,
        maximumBytes = 1024 * 1024 * 1024,
    ): Promise<Map<string, MediaDescriptor>> {
        const mediaByUrl = new Map<string, MediaDescriptor>();
        const files = this.ctx.host.files;
        const mediaDirectory = files.join(
            this.ctx.workspace().storagePath,
            'media',
        );
        files.mkdir(mediaDirectory);

        for (const [index, url] of urls.entries()) {
            let temporary: string | null = null;

            try {
                assertAllowedUrl(url);
                const mediaId = RoamExport.mediaId(
                    canonicalUrl(url),
                    workspaceId,
                );
                const existing = this.findMedia('id', mediaId);

                if (existing) {
                    mediaByUrl.set(url, descriptor(existing));
                    report.attachmentsReused++;
                } else {
                    const download = await this.fetcher.fetch(
                        url,
                        maximumBytes,
                    );
                    const hash = await sha256(download.bytes);
                    const sameBlob = this.findMedia('filename', hash);
                    const finalPath = files.join(mediaDirectory, hash);

                    if (!files.exists(finalPath)) {
                        temporary = `${finalPath}.part-${uuidv7()}`;
                        files.writeFile(temporary, download.bytes);
                        files.rename(temporary, finalPath);
                        temporary = null;
                    }

                    if (sameBlob) {
                        mediaByUrl.set(url, descriptor(sameBlob));
                        report.attachmentsReused++;
                    } else {
                        this.ctx.documents().applyChanges(
                            [
                                {
                                    type: 'media.create',
                                    payload: {
                                        id: mediaId,
                                        hash,
                                        original_name: originalName(url),
                                        mime_type: mimeType(
                                            download.bytes,
                                            download.mime_type,
                                        ),
                                        size: download.size,
                                    },
                                },
                            ],
                            'Imported from Roam Research',
                        );

                        const media = this.findMedia('id', mediaId);

                        if (!media) {
                            throw new RoamImportError(
                                'The attachment was not recorded.',
                            );
                        }

                        mediaByUrl.set(url, descriptor(media));
                        report.attachmentsImported++;
                    }
                }
            } catch (error) {
                if (temporary !== null) {
                    files.unlink(temporary);
                }

                if (error instanceof RoamImportCancelled) {
                    throw error;
                }

                report.attachmentsFailed++;
                report.warnings.push(
                    `Attachment ${originalName(url)} could not be imported: ${error instanceof Error ? error.message : String(error)}`,
                );
            }

            if (progress) {
                await progress(index + 1, urls.length);
            }
        }

        return mediaByUrl;
    }

    private findMedia(
        column: 'id' | 'filename',
        value: string,
    ): MediaRow | undefined {
        return this.ctx
            .db()
            .get<MediaRow>(
                `SELECT id, filename, original_name, mime_type, size FROM media WHERE ${column} = ? LIMIT 1`,
                [value],
            );
    }
}

function descriptor(media: MediaRow): MediaDescriptor {
    return {
        id: media.id,
        original_name: media.original_name,
        mime_type: media.mime_type,
        size: Number(media.size),
    };
}

type UrlParts = { scheme: string; host: string; path: string };

function parseUrl(url: string): UrlParts {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)/.exec(url);

    if (match === null) {
        return { scheme: '', host: '', path: urlPath(url) };
    }

    // Drop user info and port, like parse_url's host
    const authority = match[2].slice(match[2].lastIndexOf('@') + 1);
    const host = authority.startsWith('[')
        ? authority.slice(0, authority.indexOf(']') + 1)
        : authority.replace(/:\d*$/, '');

    return { scheme: match[1], host, path: urlPath(url) };
}

function assertAllowedUrl(url: string): void {
    const parts = parseUrl(url);

    if (
        parts.scheme !== 'https' ||
        parts.host.toLowerCase() !== 'firebasestorage.googleapis.com'
    ) {
        throw new RoamImportError(
            'Only HTTPS Roam Firebase uploads may be downloaded.',
        );
    }
}

/** scheme://host/path, lower-cased scheme and host, without the rotating token. */
export function canonicalUrl(url: string): string {
    const parts = parseUrl(url);

    return `${(parts.scheme || 'https').toLowerCase()}://${parts.host.toLowerCase()}${parts.path}`;
}

function originalName(url: string): string {
    let name = basename(rawUrlDecode(urlPath(url))).replace(
        /[\x00-\x1F\x7F]/g,
        '',
    );

    if (name === '') {
        return 'roam-upload';
    }

    const chars = [...name];

    if (chars.length > 240) {
        const dot = name.lastIndexOf('.');
        const extension = dot === -1 ? '' : name.slice(dot + 1);
        const stem = dot === -1 ? name : name.slice(0, dot);
        const suffix = extension !== '' ? `.${extension}` : '';
        name = [...stem].slice(0, 240 - [...suffix].length).join('') + suffix;
    }

    return name;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        bytes as Uint8Array<ArrayBuffer>,
    );

    return [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

/** The response's type, or one sniffed from the bytes (PHP used finfo). */
function mimeType(bytes: Uint8Array, header: string | null): string {
    if (header && header !== 'application/octet-stream') {
        return header;
    }

    return sniffMimeType(bytes) ?? 'application/octet-stream';
}

export function sniffMimeType(bytes: Uint8Array): string | null {
    const ascii = (offset: number, length: number) =>
        String.fromCharCode(...bytes.subarray(offset, offset + length));
    const hex = (offset: number, length: number) =>
        [...bytes.subarray(offset, offset + length)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
    const brand = ascii(8, 4);
    const signatures: [boolean, string][] = [
        [hex(0, 8) === '89504e470d0a1a0a', 'image/png'],
        [hex(0, 3) === 'ffd8ff', 'image/jpeg'],
        [ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a', 'image/gif'],
        [ascii(0, 4) === 'RIFF' && brand === 'WEBP', 'image/webp'],
        [ascii(0, 4) === 'RIFF' && brand === 'WAVE', 'audio/x-wav'],
        [ascii(0, 5) === '%PDF-', 'application/pdf'],
        [hex(0, 4) === '1a45dfa3', 'video/webm'],
        [ascii(4, 4) === 'ftyp' && brand === 'qt  ', 'video/quicktime'],
        [ascii(4, 4) === 'ftyp' && brand.startsWith('M4A'), 'audio/x-m4a'],
        [
            ascii(4, 4) === 'ftyp' && (brand === 'heic' || brand === 'heix'),
            'image/heic',
        ],
        [ascii(4, 4) === 'ftyp' && brand === 'avif', 'image/avif'],
        [ascii(4, 4) === 'ftyp', 'video/mp4'],
        [ascii(0, 3) === 'ID3' || hex(0, 2) === 'fffb', 'audio/mpeg'],
        [ascii(0, 4) === 'OggS', 'audio/ogg'],
        [hex(0, 4) === '504b0304', 'application/zip'],
    ];

    for (const [matches, type] of signatures) {
        if (matches) {
            return type;
        }
    }

    const head = bytes.subarray(0, 512);

    if (
        /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(new TextDecoder().decode(head))
    ) {
        return 'image/svg+xml';
    }

    return head.includes(0) ? null : 'text/plain';
}
