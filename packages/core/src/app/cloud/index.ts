import type { AppContext } from '../context';
import type { Workspace } from '../workspaces';

import { CloudAccount } from './account';
import type { CloudFetch } from './http';
import { CloudSync } from './sync';

export { CloudError } from './http';

/** The cloud account and the active workspace's sync, per app context. */
export type Cloud = {
    account: CloudAccount;
    /** Sync for the active workspace (a new one after a switch). */
    sync(): CloudSync;
    scheduler: SyncScheduler;
};

const clouds = new WeakMap<AppContext, Cloud>();

export function cloudFor(ctx: AppContext): Cloud {
    let cloud = clouds.get(ctx);

    if (!cloud) {
        const fetchImpl: CloudFetch =
            ctx.host.cloudFetch ?? ((input, init) => fetch(input, init));
        const syncs = new WeakMap<Workspace, CloudSync>();
        const sync = () => {
            const workspace = ctx.workspace();
            let instance = syncs.get(workspace);

            if (!instance) {
                instance = new CloudSync(
                    workspace.db,
                    workspace.documents,
                    fetchImpl,
                );
                syncs.set(workspace, instance);
            }

            return instance;
        };

        cloud = {
            account: new CloudAccount(
                ctx,
                fetchImpl,
                sync,
                ctx.host.cloudUrl ?? null,
            ),
            sync,
            scheduler: new SyncScheduler(sync),
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

    constructor(private sync: () => CloudSync) {}

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

            if (sync.configured()) {
                // Failures are recorded in sync_state for the status endpoint
                void sync.exchange().catch(() => undefined);
            }
        } catch {
            // No workspace open (shutting down)
        }
    }
}
