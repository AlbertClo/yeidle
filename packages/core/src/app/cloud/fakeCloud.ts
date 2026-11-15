import { createHash } from 'node:crypto';

import type { Host } from '../host';

import type { CloudFetch } from './http';

/** Test doubles for Yeidle Cloud: the update relay and blob storage. */

export const WORKSPACE = '00000000-0000-7000-8000-000000000001';
export const CLOUD = 'http://cloud.test';
const STORAGE = 'http://storage.test';

/** Writes a signed-in account file, as finishing the device sign-in does. */
export function signInDevice(
    ctx: { host: Host },
    userId = '1',
    url = CLOUD,
): void {
    ctx.host.files.writeFile(
        ctx.host.files.join(ctx.host.dataDirectory, 'cloud-account.json'),
        JSON.stringify({
            version: 1,
            pending: null,
            account: {
                cloud_url: url,
                token: 'token',
                user: { id: userId, name: 'Albert' },
                workspaces: [],
                preferences: { key_bindings: {} },
            },
        }),
    );
}

/** An in-memory stand-in for the Laravel relay (same request/response shapes). */
export function fakeRelay() {
    const log: {
        server_seq: number;
        document_id: string;
        update_id: string;
        device_id: string;
        bytes: string;
    }[] = [];
    let offline = false;
    /** Object storage, keyed by hash. */
    const blobs = new Map<string, Uint8Array>();
    /** Serve these bytes instead of the stored ones (corruption tests). */
    const tampered = new Map<string, Uint8Array>();

    const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        });

    const fetchImpl: CloudFetch = async (input, init) => {
        if (offline) {
            throw new TypeError('fetch failed');
        }

        const url = new URL(input);

        if (url.origin === STORAGE) {
            const hash = url.pathname.slice(1);

            if (init?.method === 'PUT') {
                const bytes = new Uint8Array(init.body as Uint8Array);
                const checksum = new Headers(init.headers).get(
                    'x-amz-checksum-sha256',
                );
                const actual = createHash('sha256')
                    .update(bytes)
                    .digest('base64');

                if (checksum !== actual) {
                    return new Response('BadDigest', { status: 400 });
                }

                blobs.set(hash, bytes);

                return new Response(null, { status: 200 });
            }

            const bytes = tampered.get(hash) ?? blobs.get(hash);

            return bytes
                ? new Response(bytes as Uint8Array<ArrayBuffer>, {
                      status: 200,
                  })
                : new Response('NoSuchKey', { status: 404 });
        }

        const blob = url.pathname.match(
            new RegExp(
                `^/api/workspaces/${WORKSPACE}/blobs/([0-9a-f]{64})(/.*)?$`,
            ),
        );

        if (blob) {
            const [, hash, action] = blob;

            if (init?.method === 'HEAD') {
                return new Response(null, {
                    status: blobs.has(hash) ? 204 : 404,
                });
            }

            if (action === '/upload-url') {
                return blobs.has(hash)
                    ? respond(200, { exists: true })
                    : respond(200, {
                          exists: false,
                          url: `${STORAGE}/${hash}`,
                          headers: {
                              'Content-Type': 'application/octet-stream',
                              'x-amz-checksum-sha256': Buffer.from(
                                  hash,
                                  'hex',
                              ).toString('base64'),
                              Host: 'storage.test',
                          },
                      });
            }

            if (action === '/download-url') {
                return blobs.has(hash)
                    ? respond(200, { url: `${STORAGE}/${hash}` })
                    : respond(404, { message: 'Not found' });
            }
        }

        if (url.pathname === '/api/broadcasting/auth') {
            return respond(200, { auth: 'key:signature' });
        }

        const base = `/api/workspaces/${WORKSPACE}/documents`;
        const latest = log.at(-1)?.server_seq ?? 0;

        if (url.pathname === `${base}/status`) {
            return respond(200, {
                workspace_id: WORKSPACE,
                user_id: '1',
                latest_seq: latest,
                realtime: { enabled: false },
            });
        }

        if (url.pathname === `${base}/updates` && init?.method === 'POST') {
            const body = JSON.parse(String(init.body)) as {
                device_id: string;
                updates: {
                    update_id: string;
                    document_id: string;
                    bytes: string;
                }[];
            };
            const accepted = body.updates.map((update) => {
                let row = log.find((r) => r.update_id === update.update_id);

                if (!row) {
                    row = {
                        ...update,
                        device_id: body.device_id,
                        server_seq: (log.at(-1)?.server_seq ?? 0) + 1,
                    };
                    log.push(row);
                }

                return { update_id: row.update_id, server_seq: row.server_seq };
            });

            return respond(200, { accepted });
        }

        if (url.pathname === `${base}/updates`) {
            const since = Number(url.searchParams.get('since'));
            const exclude = url.searchParams.get('exclude_device');
            const limit = 3; // small pages exercise has_more
            const rows = log.filter(
                (row) => row.server_seq > since && row.device_id !== exclude,
            );
            const page = rows.slice(0, limit);
            const hasMore = rows.length > limit;

            return respond(200, {
                updates: page,
                cursor: hasMore
                    ? page.at(-1)!.server_seq
                    : Math.max(since, latest),
                latest_seq: latest,
                has_more: hasMore,
            });
        }

        return respond(404, { message: 'Not found' });
    };

    return {
        log,
        blobs,
        tampered,
        fetch: fetchImpl,
        setOffline(value: boolean) {
            offline = value;
        },
    };
}
