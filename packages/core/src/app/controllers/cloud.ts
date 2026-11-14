import { json } from '../../http/http';
import type { AppResponse } from '../../http/http';
import type { Router } from '../../http/router';
import { cloudFor, CloudError } from '../cloud';
import type { AppContext } from '../context';
import { WorkspaceError } from '../workspaces';

/** The cloud account (device sign-in) and the active workspace's cloud sync. */
export function registerCloudRoutes(router: Router, ctx: AppContext): void {
    const cloud = () => cloudFor(ctx);

    // Cloud failures become a JSON message with the given status
    const failing = async (
        status: number,
        fn: () => Promise<unknown> | unknown,
        success = 200,
    ): Promise<AppResponse> => {
        try {
            return json(await fn(), success);
        } catch (error) {
            if (
                error instanceof CloudError ||
                error instanceof WorkspaceError
            ) {
                return json({ message: error.message }, status);
            }

            throw error;
        }
    };

    router.get('/api/account', () => json(cloud().account.status()));

    router.post('/api/account/connect', ({ input }) =>
        failing(
            422,
            () =>
                cloud().account.begin(
                    input.optionalString('device_name') ??
                        ctx.host.deviceName ??
                        'Yeidle desktop',
                ),
            201,
        ),
    );

    router.delete('/api/account/connect', () => {
        cloud().account.cancelAuthorization();

        return json({ cancelled: true });
    });

    router.post('/api/account/complete', () =>
        failing(422, () => cloud().account.completeAuthorization()),
    );

    router.post('/api/account/broadcasting-auth', ({ input }) =>
        failing(403, () =>
            cloud().account.authorizePendingRealtime(
                input.string('socket_id'),
                input.string('channel_name'),
            ),
        ),
    );

    router.post('/api/account/refresh', () =>
        failing(422, () => cloud().account.refresh()),
    );

    router.post('/api/account/sync-active-workspace', () =>
        failing(422, async () => {
            const result = await cloud().account.syncActiveWorkspace();
            cloud().scheduler.nudge(0);

            return result;
        }),
    );

    router.delete('/api/account', async () => {
        await cloud().account.logout();

        return json({ signed_out: true });
    });

    router.get('/api/cloud/status', () =>
        json({
            ...cloud().sync().status(),
            pending_blob_uploads: cloud().sync().configured()
                ? cloud().blobs().pendingUploadCount()
                : 0,
        }),
    );

    // Notes first; files follow in the background
    const exchange = async () => {
        const result = await cloud().sync().exchange();

        if (result.configured) {
            void cloud().blobs().run();
        }

        return result;
    };

    router.get('/api/cloud/realtime-config', async () => {
        try {
            return json(await cloud().sync().realtimeConfig());
        } catch {
            return json(
                { message: 'Realtime sync configuration is unavailable.' },
                503,
            );
        }
    });

    router.post('/api/cloud/broadcasting-auth', ({ input }) =>
        failing(403, () =>
            cloud()
                .sync()
                .authorizeRealtime(
                    input.string('socket_id'),
                    input.string('channel_name'),
                ),
        ),
    );

    // A realtime event only says the log grew: pull it
    router.post('/api/cloud/realtime-ops', async () => {
        const result = await exchange();

        return json({
            applied: result.pulled,
            needs_pull: false,
            ignored: !result.configured,
        });
    });

    router.post('/api/sync/cloud-exchange', async () => {
        const result = await exchange();

        return json(result);
    });

    // The PHP app's manual pairing endpoints (url + token); sign-in replaces them
    router.post('/api/cloud/connect', () =>
        json({ message: 'Sign in to Yeidle Cloud to sync a workspace.' }, 422),
    );
    router.post('/api/cloud/workspaces', () =>
        json({ message: 'Sign in to Yeidle Cloud to sync a workspace.' }, 422),
    );
}
