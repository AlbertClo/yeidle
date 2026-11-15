import { json } from '../../http/http';
import type { Router } from '../../http/router';
import { cloudFor, CloudError } from '../cloud';
import type { AppContext } from '../context';
import { WorkspaceError } from '../workspaces';

/** Local workspaces: list, create, rename, delete, switch, reveal on disk. */
export function registerWorkspaceRoutes(router: Router, ctx: AppContext): void {
    const failing = (status: number, fn: () => unknown) => {
        try {
            return json(fn());
        } catch (error) {
            if (error instanceof WorkspaceError) {
                return json({ message: error.message }, status);
            }

            throw error;
        }
    };

    const cloudFailing = async (status: number, fn: () => Promise<unknown>) => {
        try {
            return json(await fn());
        } catch (error) {
            if (
                error instanceof WorkspaceError ||
                error instanceof CloudError
            ) {
                return json({ message: error.message }, status);
            }

            throw error;
        }
    };

    router.get('/api/workspaces', () => json(ctx.workspaces.state()));

    router.post('/api/workspaces', ({ input }) => {
        const name = input.string('name', { max: 100 });

        try {
            return json({ workspace: ctx.workspaces.create(name) }, 201);
        } catch (error) {
            if (error instanceof WorkspaceError) {
                return json({ message: error.message }, 422);
            }

            throw error;
        }
    });

    // Cloud workspaces are renamed and deleted through the cloud account
    const isCloud = (id: string) =>
        ctx.workspaces.find(id).cloud_status !== 'local';

    router.patch('/api/workspaces/{workspaceId}', async ({ params, input }) => {
        const name = input.string('name', { max: 100 });

        return cloudFailing(422, async () => ({
            workspace: isCloud(params.workspaceId)
                ? await cloudFor(ctx).account.renameWorkspace(
                      params.workspaceId,
                      name,
                  )
                : ctx.workspaces.rename(params.workspaceId, name),
        }));
    });

    router.delete('/api/workspaces/{workspaceId}', async ({ params }) =>
        cloudFailing(422, async () =>
            isCloud(params.workspaceId)
                ? await cloudFor(ctx).account.deleteWorkspace(
                      params.workspaceId,
                  )
                : ctx.workspaces.delete(params.workspaceId),
        ),
    );

    router.post('/api/workspaces/{workspaceId}/activate', ({ params }) =>
        failing(404, () => ({
            workspace: ctx.workspaces.activate(params.workspaceId),
        })),
    );

    router.post('/api/workspaces/{workspaceId}/sync', async ({ params }) =>
        cloudFailing(422, async () => ({
            workspace: await cloudFor(ctx).account.enableWorkspaceSync(
                params.workspaceId,
            ),
        })),
    );

    router.post(
        '/api/workspaces/{workspaceId}/show-on-disk',
        ({ params, input }) =>
            failing(404, () => {
                const record = ctx.workspaces.find(params.workspaceId);
                const target = input.optionalString('target') ?? 'database';
                const files = ctx.host.files;

                if (target === 'media') {
                    const media = ctx.workspaces.mediaPath(record);
                    files.mkdir(media);
                    ctx.host.showItemInFolder(media);
                } else {
                    const database = ctx.workspaces.databasePath(record);

                    if (!files.isFile(database)) {
                        throw new WorkspaceError(
                            'The workspace database was not found on this device.',
                        );
                    }

                    ctx.host.showItemInFolder(database);
                }

                return null;
            }),
    );
}
