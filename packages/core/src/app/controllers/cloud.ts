import { json } from '../../http/http';
import type { Router } from '../../http/router';
import type { AppContext } from '../context';

/**
 * Cloud sync and the cloud account aren't ported to the new app yet. These
 * routes answer the way the PHP app did when no cloud was configured, so the
 * UI shows a local-only workspace.
 */
export function registerCloudRoutes(router: Router, ctx: AppContext): void {
    const unavailable = () =>
        json({ message: 'Yeidle Cloud is not available in this version yet.' }, 422);

    router.get('/api/account', () =>
        json({
            signed_in: false,
            user: null,
            workspaces: [],
            preferences: { key_bindings: [] },
            authorization_pending: false,
            authorization_id: null,
            authorization_expires_at: null,
            verification_url: null,
            authorization_realtime: null,
        }),
    );
    router.post('/api/account/connect', unavailable);
    router.delete('/api/account/connect', () => json({ cancelled: true }));
    router.post('/api/account/complete', unavailable);
    router.post('/api/account/broadcasting-auth', () => json({ message: 'Forbidden.' }, 403));
    router.post('/api/account/refresh', unavailable);
    router.post('/api/account/sync-active-workspace', unavailable);
    router.delete('/api/account', () => json({ signed_out: true }));

    router.post('/api/cloud/connect', unavailable);
    router.post('/api/cloud/workspaces', unavailable);
    router.get('/api/cloud/status', () =>
        json({
            configured: false,
            health: 'unconfigured',
            cloud_url: null,
            workspace_id: null,
            cloud_seed_pending: false,
            last_server_seq: 0,
            local_log_seq: ctx.documents().store.changesSince(0).seq,
            outbox: 0,
            pending_blob_uploads: 0,
            last_sync_attempt_at: null,
            last_sync_success_at: null,
            last_sync_error: null,
        }),
    );
    router.get('/api/cloud/realtime-config', () => json({ enabled: false }));
    router.post('/api/cloud/broadcasting-auth', () => json({ message: 'Forbidden.' }, 403));
    router.post('/api/cloud/realtime-ops', () => json({ applied: 0, needs_pull: false, ignored: true }));
    router.post('/api/sync/cloud-exchange', () => json({ pushed: 0, pulled: 0 }));
}
