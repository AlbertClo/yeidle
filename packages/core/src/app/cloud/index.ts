import type { AppContext } from '../context';
import type { Workspace } from '../workspaces';

import { CloudAccount } from './account';
import { CloudBlobs } from './blobs';
import type { CloudFetch } from './http';
import { CloudSync } from './sync';

export { CloudError } from './http';

/** The cloud account and the active workspace's sync, per app context. */
export type Cloud = {
    account: CloudAccount;
    /** Sync for the active workspace (a new one after a switch). */
    sync(): CloudSync;
    /** Media files for the active workspace. */
    blobs(): CloudBlobs;
    scheduler: SyncScheduler;
};

const clouds = new WeakMap<AppContext, Cloud>();

export function cloudFor(ctx: AppContext): Cloud {
    let cloud = clouds.get(ctx);

    if (!cloud) {
        const fetchImpl: CloudFetch =
            ctx.host.cloudFetch ?? ((input, init) => fetch(input, init));
        const perWorkspace = new WeakMap<
            Workspace,
            { sync: CloudSync; blobs: CloudBlobs }
        >();
        const services = () => {
            const workspace = ctx.workspace();
            let instance = perWorkspace.get(workspace);

            if (!instance) {
                const sync = new CloudSync(
                    workspace.db,
                    workspace.documents,
                    fetchImpl,
                    () => {
                        const account = cloud!.account.account();

                        return account === null
                            ? null
                            : { url: account.cloud_url, token: account.token };
                    },
                );
                const blobs = new CloudBlobs(
                    workspace.db,
                    ctx.host.files,
                    ctx.host.files.join(workspace.storagePath, 'media'),
                    fetchImpl,
                    () => sync.connection(),
                );
                instance = { sync, blobs };
                perWorkspace.set(workspace, instance);
            }

            return instance;
        };
        const sync = () => services().sync;
        const blobs = () => services().blobs;

        cloud = {
            account: new CloudAccount(
                ctx,
                fetchImpl,
                sync,
                ctx.host.cloudUrl ?? null,
            ),
            sync,
            blobs,
            scheduler: new SyncScheduler(sync, blobs),
        };
        clouds.set(ctx, cloud);
    }

    return cloud;
}

/**
 * Runs exchanges in the background: shortly after local changes, and on a
 * slow interval as a fallback for missed realtime events.
 */
export class SyncScheduler {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private interval: ReturnType<typeof setInterval> | null = null;

    constructor(
        private sync: () => CloudSync,
        private blobs: () => CloudBlobs,
    ) {}

    start(intervalMs = 15_000): void {
        this.stop();
        this.interval = setInterval(() => this.run(), intervalMs);
        this.nudge(0);
    }

    stop(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        if (this.interval !== null) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    /** Schedules an exchange soon, coalescing bursts of changes. */
    nudge(delayMs = 300): void {
        if (this.timer !== null) {
            return;
        }

        this.timer = setTimeout(() => {
            this.timer = null;
            this.run();
        }, delayMs);
    }

    private run(): void {
        try {
            const sync = this.sync();
            const blobs = this.blobs();

            if (sync.configured()) {
                // Failures are recorded in meta for the status endpoint.
                // Files move after notes, in their own pass, so a large
                // upload never holds back text
                void sync
                    .exchange()
                    .catch(() => undefined)
                    .then(() => blobs.run());
            }
        } catch {
            // No workspace open (shutting down)
        }
    }
}
