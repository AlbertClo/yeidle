import type { Database } from '../../db/database';
import type { DocumentService } from '../../documents/service';
import { fromBase64, toBase64 } from '../../support/base64';
import { sqlTimestamp } from '../../support/time';
import { syncIdentity } from '../services/accountRoots';

import { CloudError, cloudMessage, cloudRequest } from './http';
import type { CloudFetch } from './http';

/**
 * Syncs one workspace's Loro update log with its cloud workspace. The cloud
 * relays opaque bytes; merging is Loro's job, so sync only has to deliver
 * every update everywhere at least once.
 *
 *   push: local updates with cloud_seq NULL (the outbox), in size-capped
 *         batches; the cloud acknowledges each with its server_seq
 *   pull: updates after sync_state.last_server_seq from other devices,
 *         imported through DocumentService (store, project, notify windows)
 *
 * Pairing rules: an empty cloud workspace is seeded from this device, an
 * empty local workspace is filled from the cloud, and two non-empty sides
 * are refused — the same notes converted separately on two devices are
 * different Loro histories and would merge into duplicates.
 */

type SyncStateRow = {
    id: number;
    client_id: string;
    last_server_seq: number;
    cloud_url: string | null;
    cloud_token: string | null;
    workspace_id: string | null;
    cloud_seed_pending: number;
    last_sync_attempt_at: string | null;
    last_sync_success_at: string | null;
    last_sync_error: string | null;
    cloud_user_id: string | null;
};

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

    constructor(
        private db: Database,
        private documents: DocumentService,
        private fetchImpl: CloudFetch,
    ) {}

    configured(): boolean {
        const state = this.state();

        return (
            state.cloud_url !== null &&
            state.cloud_token !== null &&
            state.workspace_id !== null
        );
    }

    /** Where and as whom to reach the cloud, or null when not paired. */
    connection(): { url: string; token: string; workspaceId: string } | null {
        const state = this.state();

        return this.configured()
            ? {
                  url: state.cloud_url!,
                  token: state.cloud_token!,
                  workspaceId: state.workspace_id!,
              }
            : null;
    }

    /** Pairs this workspace with a cloud workspace, then syncs once. */
    async connect(
        url: string,
        token: string,
        workspaceId: string,
    ): Promise<ConnectResult> {
        url = url.replace(/\/+$/, '');
        const status = await cloudRequest(
            this.fetchImpl,
            'GET',
            `${url}/api/workspaces/${workspaceId}/documents/status`,
            { token },
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

        const state = this.state();
        const sameWorkspace = state.workspace_id === workspaceId;

        if (state.workspace_id !== null && !sameWorkspace) {
            throw new CloudError(
                'This workspace is already connected to a different cloud workspace.',
            );
        }

        const localHasData =
            this.db.get('SELECT 1 FROM document_updates LIMIT 1') !== undefined;
        let seeded = false;
        let bootstrapped = false;

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
        }

        this.db.run(
            `UPDATE sync_state SET cloud_url = ?, cloud_token = ?, workspace_id = ?,
                cloud_user_id = COALESCE(?, cloud_user_id),
                last_server_seq = CASE WHEN ? THEN last_server_seq ELSE 0 END,
                last_sync_error = NULL
             WHERE id = ?`,
            [
                url,
                token,
                workspaceId,
                typeof userId === 'string' && userId !== '' ? userId : null,
                sameWorkspace,
                state.id,
            ],
        );

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

    /** Forgets the token (signing out); the pairing itself is kept. */
    signOut(): void {
        this.db.run('UPDATE sync_state SET cloud_token = NULL');
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
        const state = this.state();
        const configured = this.configured();
        const outbox =
            this.db.get<{ count: number }>(
                'SELECT COUNT(*) AS count FROM document_updates WHERE cloud_seq IS NULL',
            )?.count ?? 0;
        const health = !configured
            ? 'unconfigured'
            : state.last_sync_error !== null
              ? 'error'
              : state.last_sync_success_at !== null
                ? 'healthy'
                : 'never_synced';

        return {
            configured,
            health,
            cloud_url: state.cloud_url,
            workspace_id: state.workspace_id,
            cloud_seed_pending: false,
            last_server_seq: state.last_server_seq,
            local_log_seq: this.documents.store.changesSince(0).seq,
            outbox: configured ? outbox : 0,
            pending_blob_uploads: 0,
            last_sync_attempt_at: state.last_sync_attempt_at,
            last_sync_success_at: state.last_sync_success_at,
            last_sync_error: state.last_sync_error,
        };
    }

    /** Public Reverb settings for the renderer (never the token). */
    async realtimeConfig(): Promise<RealtimeConfig> {
        const state = this.state();

        if (!this.configured()) {
            return { enabled: false };
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'GET',
            this.workspaceUrl(state, 'documents/status'),
            { token: state.cloud_token! },
        );

        if (!response.ok) {
            throw new CloudError(
                cloudMessage(response, 'Could not load realtime settings'),
                response.status,
            );
        }

        const realtime = response.body?.realtime as
            | Record<string, unknown>
            | undefined;

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
            workspace_id: state.workspace_id!,
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
        const state = this.state();

        if (!this.configured()) {
            throw new CloudError('Cloud sync is not configured.');
        }

        if (channelName !== `private-workspaces.${state.workspace_id}.sync`) {
            throw new CloudError('The realtime channel is not allowed.');
        }

        const response = await cloudRequest(
            this.fetchImpl,
            'POST',
            `${state.cloud_url}/api/broadcasting/auth`,
            {
                token: state.cloud_token!,
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
        if (!this.configured()) {
            return {
                configured: false,
                ok: false,
                pushed: 0,
                pulled: 0,
                error: null,
            };
        }

        this.db.run('UPDATE sync_state SET last_sync_attempt_at = ?', [
            sqlTimestamp(),
        ]);

        const errors: string[] = [];
        let pushed = 0;
        let pulled = 0;

        // Push and pull are independent: a stuck outbox never blocks
        // receiving, and the reverse
        try {
            pushed = await this.push();
        } catch (error) {
            errors.push(`Push failed: ${describe(error)}`);
        }

        try {
            pulled = await this.pull();
        } catch (error) {
            errors.push(`Pull failed: ${describe(error)}`);
        }

        const error = errors.length > 0 ? errors.join(' ') : null;

        if (error === null) {
            this.db.run(
                'UPDATE sync_state SET last_sync_success_at = ?, last_sync_error = NULL',
                [sqlTimestamp()],
            );
        } else {
            this.db.run('UPDATE sync_state SET last_sync_error = ?', [error]);
        }

        return { configured: true, ok: error === null, pushed, pulled, error };
    }

    private async push(): Promise<number> {
        const state = this.state();
        let pushed = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const rows = this.db.all<{
                id: number;
                update_id: string;
                document_id: string;
                bytes: Uint8Array;
            }>(
                `SELECT id, update_id, document_id, bytes FROM document_updates
                 WHERE cloud_seq IS NULL ORDER BY id LIMIT ?`,
                [PUSH_MAX_UPDATES],
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
                this.workspaceUrl(state, 'documents/updates'),
                {
                    token: state.cloud_token!,
                    json: {
                        device_id: state.client_id,
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
                            'UPDATE document_updates SET cloud_seq = ? WHERE id = ?',
                            [seq, row.id],
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

    private async pull(): Promise<number> {
        let pulled = 0;

        for (let round = 0; round < MAX_ROUNDS; round++) {
            const state = this.state();
            const query = new URLSearchParams({
                since: String(state.last_server_seq),
                exclude_device: state.client_id,
            });
            const response = await cloudRequest(
                this.fetchImpl,
                'GET',
                `${this.workspaceUrl(state, 'documents/updates')}?${query}`,
                { token: state.cloud_token!, timeoutMs: 120_000 },
            );

            if (!response.ok) {
                throw new CloudError(
                    cloudMessage(response, 'Could not pull updates'),
                    response.status,
                );
            }

            const updates = response.body?.updates as
                | PulledUpdate[]
                | undefined;
            const cursor = response.body?.cursor;

            if (!Array.isArray(updates) || typeof cursor !== 'number') {
                throw new CloudError(
                    'Yeidle Cloud returned an invalid pull response.',
                );
            }

            this.apply(updates);
            this.db.run(
                'UPDATE sync_state SET last_server_seq = ? WHERE id = ?',
                [Math.max(cursor, state.last_server_seq), state.id],
            );
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
                    client_id: update.device_id,
                    bytes: fromBase64(update.bytes),
                    cloud_seq: update.server_seq,
                })),
            );
        }
    }

    private workspaceUrl(state: SyncStateRow, path: string): string {
        return `${state.cloud_url}/api/workspaces/${state.workspace_id}/${path}`;
    }

    private state(): SyncStateRow {
        syncIdentity(this.db);

        return this.db.get<SyncStateRow>(
            'SELECT * FROM sync_state ORDER BY id LIMIT 1',
        )!;
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
