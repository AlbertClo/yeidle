import type { Database } from '../../db/database';
import { Meta } from '../../db/meta';
import type { DocumentService } from '../../documents/service';
import { fromBase64, toBase64 } from '../../support/base64';
import { LOCAL_USER_DOCUMENT_ID } from '../services/userDocument';

import { CloudError, cloudMessage, cloudRequest } from './http';
import type { CloudFetch } from './http';

/**
 * Syncs one workspace's Loro update log with its cloud workspace. The cloud
 * relays opaque bytes; merging is Loro's job, so sync only has to deliver
 * every update everywhere at least once.
 *
 *   push: local updates with cloud_seq NULL (the outbox), in size-capped
 *         batches; the cloud acknowledges each with its server_seq
 *   pull: updates after the cloud cursor (meta) from other devices,
 *         imported through DocumentService (store, project, notify windows)
 *
 * The account file holds the cloud URL and token; this workspace's meta
 * holds whether it's paired and how far it has pulled. `user:local` never
 * leaves the device.
 *
 * Pairing rules: an empty cloud workspace is seeded from this device, an
 * empty local workspace is filled from the cloud, and two non-empty sides
 * are refused — the same notes converted separately on two devices are
 * different Loro histories and would merge into duplicates.
 */

export type CloudCredentials = { url: string; token: string };

type PulledUpdate = {
    server_seq: number;
    document_id: string;
    update_id: string;
    device_id: string;
    bytes: string;
};

export type ExchangeResult = {
    configured: boolean;
    ok: boolean;
    pushed: number;
    pulled: number;
    error: string | null;
};

export type ConnectResult = {
    seeded: boolean;
    bootstrapped: boolean;
    pushed: number;
    pulled: number;
    ok: boolean;
    error: string | null;
};

export type RealtimeConfig =
    | { enabled: false }
    | {
          enabled: true;
          workspace_id: string;
          app_key: string;
          host: string;
          port: number;
          scheme: 'http' | 'https';
      };

/** Raw update bytes per push request (one larger update still goes alone). */
const PUSH_MAX_BYTES = 2 * 1024 * 1024;
const PUSH_MAX_UPDATES = 200;
/** Stops a runaway loop; the next exchange continues where this one ended. */
const MAX_ROUNDS = 1000;

export class CloudSync {
    private running: Promise<ExchangeResult> | null = null;
    private again = false;
    private meta: Meta;

    constructor(
        private db: Database,
        private documents: DocumentService,
        private fetchImpl: CloudFetch,
        /** The signed-in account's cloud, or null when signed out. */
        private credentials: () => CloudCredentials | null,
    ) {
        this.meta = new Meta(db);
    }

    configured(): boolean {
        return this.connection() !== null;
    }

    /** Where and as whom to reach the cloud, or null when not paired or signed out. */
    connection(): { url: string; token: string; workspaceId: string } | null {
        const credentials = this.credentials();
        const workspaceId = this.meta.get('cloud_workspace_id');

        return credentials !== null && workspaceId !== null
            ? { ...credentials, workspaceId }
            : null;
    }

    /** Pairs this workspace with a cloud workspace, then syncs once. */
    async connect(workspaceId: string): Promise<ConnectResult> {
        const credentials = this.credentials();

        if (credentials === null) {
            throw new CloudError('Sign in to Yeidle Cloud first.');
        }

        const status = await cloudRequest(
            this.fetchImpl,
            'GET',
            `${credentials.url}/api/workspaces/${workspaceId}/documents/status`,
            { token: credentials.token },
        );

        if (!status.ok) {
            throw new CloudError(
                cloudMessage(status, 'Could not reach the cloud workspace'),
                status.status,
            );
        }

        const cloudSeq = status.body?.latest_seq;
        const userId = status.body?.user_id;

        if (
            status.body?.workspace_id !== workspaceId ||
            typeof cloudSeq !== 'number' ||
            cloudSeq < 0
        ) {
            throw new CloudError(
                'Yeidle Cloud returned an invalid sync status.',
            );
        }

        const pairedWith = this.meta.get('cloud_workspace_id');
        const sameWorkspace = pairedWith === workspaceId;

        if (pairedWith !== null && !sameWorkspace) {
            throw new CloudError(
                'This workspace is already connected to a different cloud workspace.',
            );
        }

        const localHasData =
            this.db.get(
                'SELECT 1 FROM document_updates WHERE document_id != ? LIMIT 1',
                [LOCAL_USER_DOCUMENT_ID],
            ) !== undefined;
        let seeded = false;
        let bootstrapped = false;

        this.db.transaction(() => {
            if (!sameWorkspace) {
                if (cloudSeq > 0 && localHasData) {
                    throw new CloudError(
                        'This workspace has notes both on this device and in Yeidle Cloud. ' +
                            'Open the cloud workspace from an empty workspace instead.',
                    );
                }

                seeded = cloudSeq === 0 && localHasData;
                bootstrapped = cloudSeq > 0;
                // Everything local goes up; everything in the cloud comes down
                this.db.run('UPDATE document_updates SET cloud_seq = NULL');
                this.meta.set('cloud_cursor', 0);
            }

            this.meta.set('cloud_workspace_id', workspaceId);

            if (typeof userId === 'string' && userId !== '') {
                this.meta.set('cloud_user_id', userId);
            }

            this.meta.set('cloud_last_error', null);
        });

        const exchange = await this.exchange();

        return {
            seeded,
            bootstrapped,
            pushed: exchange.pushed,
            pulled: exchange.pulled,
            ok: exchange.ok,
            error: exchange.error,
        };
    }

    /**
     * One sync round: push the outbox, then pull. Concurrent callers share
     * the running round; calls during it schedule exactly one more.
     */
    exchange(): Promise<ExchangeResult> {
        if (this.running) {
            this.again = true;

            return this.running;
        }

        this.running = (async () => {
            let result: ExchangeResult;

            do {
                this.again = false;
                result = await this.exchangeOnce();
            } while (this.again && result.ok);

            return result;
        })().finally(() => {
            this.running = null;
        });

        return this.running;
    }

    status(): Record<string, unknown> {
        const connection = this.connection();
        const error = this.meta.get('cloud_last_error');
        const lastSuccess = this.meta.number('cloud_last_success_at');
        const outbox = connection === null ? 0 : this.outboxSize();
        const health =
            connection === null
                ? 'unconfigured'
                : error !== null
                  ? 'error'
                  : lastSuccess !== null
                    ? 'healthy'
                    : 'never_synced';

        return {
            configured: connection !== null,
            health,
            cloud_url: connection?.url ?? null,
            workspace_id: this.meta.get('cloud_workspace_id'),
            cloud_cursor: this.meta.number('cloud_cursor') ?? 0,
            local_log_seq: this.documents.store.changesSince(0).seq,
            outbox,
            pending_blob_uploads: 0,
            last_sync_attempt_at: isoTime(
                this.meta.number('cloud_last_attempt_at'),
            ),
            last_sync_success_at: isoTime(lastSuccess),
            last_sync_error: error,
        };
    }

    /** Public Reverb settings for the renderer (never the token). */
    async realtimeConfig(): Promise<RealtimeConfig> {
        const connection = this.connection();

        if (connection === null) {
            return { enabled: false };
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'GET',
            this.workspaceUrl(connection, 'documents/status'),
            { token: connection.token },
        );

        if (!response.ok) {
            throw new CloudError(
                cloudMessage(response, 'Could not load realtime settings'),
                response.status,
            );
        }

        const realtime = response.body?.realtime as
            Record<string, unknown> | undefined;

        if (
            realtime?.enabled !== true ||
            typeof realtime.app_key !== 'string' ||
            typeof realtime.host !== 'string' ||
            typeof realtime.port !== 'number' ||
            (realtime.scheme !== 'http' && realtime.scheme !== 'https')
        ) {
            return { enabled: false };
        }

        return {
            enabled: true,
            workspace_id: connection.workspaceId,
            app_key: realtime.app_key,
            host: realtime.host,
            port: realtime.port,
            scheme: realtime.scheme,
        };
    }

    /** Signs a Reverb subscription to this workspace's channel with the stored token. */
    async authorizeRealtime(
        socketId: string,
        channelName: string,
    ): Promise<Record<string, unknown>> {
        const connection = this.connection();

        if (connection === null) {
            throw new CloudError('Cloud sync is not configured.');
        }

        const workspace = `workspaces.${connection.workspaceId}`;
        const allowed =
            channelName === `private-${workspace}.sync` ||
            // Who's on a page, and their cursors
            new RegExp(
                `^presence-${workspace.replaceAll('.', '\\.')}\\.documents\\.[0-9a-zA-Z-]{1,64}$`,
            ).test(channelName);

        if (!allowed) {
            throw new CloudError('The realtime channel is not allowed.');
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'POST',
            `${connection.url}/api/broadcasting/auth`,
            {
                token: connection.token,
                form: { socket_id: socketId, channel_name: channelName },
            },
        );

        if (!response.ok || typeof response.body?.auth !== 'string') {
            throw new CloudError(
                'Realtime authorization failed.',
                response.status,
            );
        }

        return response.body;
    }

    private async exchangeOnce(): Promise<ExchangeResult> {
        const connection = this.connection();

        if (connection === null) {
            return {
                configured: false,
                ok: false,
                pushed: 0,
                pulled: 0,
                error: null,
            };
        }

        this.meta.set('cloud_last_attempt_at', Date.now());

        const errors: string[] = [];
        let pushed = 0;
        let pulled = 0;

        // Push and pull are independent: a stuck outbox never blocks
        // receiving, and the reverse
        try {
            pushed = await this.push(connection);
        } catch (error) {
            errors.push(`Push failed: ${describe(error)}`);
        }

        try {
            pulled = await this.pull(connection);
        } catch (error) {
            errors.push(`Pull failed: ${describe(error)}`);
        }

        const error = errors.length > 0 ? errors.join(' ') : null;

        if (error === null) {
            this.meta.set('cloud_last_success_at', Date.now());
        }

        this.meta.set('cloud_last_error', error);

        return { configured: true, ok: error === null, pushed, pulled, error };
    }

    private async push(connection: Connection): Promise<number> {
        const deviceId = this.meta.deviceId();
        let pushed = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const rows = this.db.all<{
                seq: number;
                update_id: string;
                document_id: string;
                bytes: Uint8Array;
            }>(
                `SELECT seq, update_id, document_id, bytes FROM document_updates
                 WHERE cloud_seq IS NULL AND document_id != ? ORDER BY seq LIMIT ?`,
                [LOCAL_USER_DOCUMENT_ID, PUSH_MAX_UPDATES],
            );

            if (rows.length === 0) {
                break;
            }

            const batch: typeof rows = [];
            let size = 0;

            for (const row of rows) {
                if (
                    batch.length > 0 &&
                    size + row.bytes.length > PUSH_MAX_BYTES
                ) {
                    break;
                }

                batch.push(row);
                size += row.bytes.length;
            }

            const response = await cloudRequest(
                this.fetchImpl,
                'POST',
                this.workspaceUrl(connection, 'documents/updates'),
                {
                    token: connection.token,
                    json: {
                        device_id: deviceId,
                        updates: batch.map((row) => ({
                            update_id: row.update_id,
                            document_id: row.document_id,
                            bytes: toBase64(row.bytes),
                        })),
                    },
                    timeoutMs: 120_000,
                },
            );

            if (!response.ok) {
                throw new CloudError(
                    cloudMessage(response, 'The cloud refused the updates'),
                    response.status,
                );
            }

            const accepted = response.body?.accepted;

            if (!Array.isArray(accepted)) {
                throw new CloudError(
                    'Yeidle Cloud returned an invalid push response.',
                );
            }

            const acked = new Map<string, number>();

            for (const ack of accepted as {
                update_id?: unknown;
                server_seq?: unknown;
            }[]) {
                if (
                    typeof ack.update_id === 'string' &&
                    typeof ack.server_seq === 'number'
                ) {
                    acked.set(ack.update_id, ack.server_seq);
                }
            }

            this.db.transaction(() => {
                for (const row of batch) {
                    const seq = acked.get(row.update_id);

                    if (seq !== undefined) {
                        this.db.run(
                            'UPDATE document_updates SET cloud_seq = ? WHERE seq = ?',
                            [seq, row.seq],
                        );
                    }
                }
            });

            if (batch.some((row) => !acked.has(row.update_id))) {
                throw new CloudError(
                    'Yeidle Cloud did not acknowledge every update.',
                );
            }

            pushed += batch.length;
        }

        return pushed;
    }

    private async pull(connection: Connection): Promise<number> {
        let pulled = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const since = this.meta.number('cloud_cursor') ?? 0;
            const query = new URLSearchParams({
                since: String(since),
                exclude_device: this.meta.deviceId(),
            });
            const response = await cloudRequest(
                this.fetchImpl,
                'GET',
                `${this.workspaceUrl(connection, 'documents/updates')}?${query}`,
                { token: connection.token, timeoutMs: 120_000 },
            );

            if (!response.ok) {
                throw new CloudError(
                    cloudMessage(response, 'Could not pull updates'),
                    response.status,
                );
            }

            const updates = response.body?.updates as
                PulledUpdate[] | undefined;
            const cursor = response.body?.cursor;

            if (!Array.isArray(updates) || typeof cursor !== 'number') {
                throw new CloudError(
                    'Yeidle Cloud returned an invalid pull response.',
                );
            }

            this.apply(updates);
            this.meta.set('cloud_cursor', Math.max(cursor, since));
            pulled += updates.length;

            if (response.body?.has_more !== true) {
                break;
            }
        }

        return pulled;
    }

    /** Imports pulled updates document by document, keeping log order. */
    private apply(updates: PulledUpdate[]): void {
        let index = 0;

        while (index < updates.length) {
            const documentId = updates[index].document_id;
            const group: PulledUpdate[] = [];

            while (
                index < updates.length &&
                updates[index].document_id === documentId
            ) {
                group.push(updates[index]);
                index++;
            }

            this.documents.applyUpdates(
                documentId,
                group.map((update) => ({
                    update_id: update.update_id,
                    origin: update.device_id,
                    bytes: fromBase64(update.bytes),
                    cloud_seq: update.server_seq,
                })),
            );
        }
    }

    private outboxSize(): number {
        return (
            this.db.get<{ count: number }>(
                'SELECT COUNT(*) AS count FROM document_updates WHERE cloud_seq IS NULL AND document_id != ?',
                [LOCAL_USER_DOCUMENT_ID],
            )?.count ?? 0
        );
    }

    private workspaceUrl(connection: Connection, path: string): string {
        return `${connection.url}/api/workspaces/${connection.workspaceId}/${path}`;
    }
}

type Connection = { url: string; token: string; workspaceId: string };

function isoTime(ms: number | null): string | null {
    return ms === null ? null : new Date(ms).toISOString();
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
