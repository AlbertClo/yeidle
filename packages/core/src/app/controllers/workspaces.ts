import { json } from '../../http/http';
import type { Router } from '../../http/router';
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

    // Cloud workspaces are renamed and deleted through the cloud account,
    // which isn't ported yet; local ones are handled here
    router.patch('/api/workspaces/{workspaceId}', ({ params, input }) => {
        const name = input.string('name', { max: 100 });

        return failing(422, () => ({ workspace: ctx.workspaces.rename(params.workspaceId, name) }));
    });

    router.delete('/api/workspaces/{workspaceId}', ({ params }) =>
        failing(422, () => ctx.workspaces.delete(params.workspaceId)),
    );

    router.post('/api/workspaces/{workspaceId}/activate', ({ params }) =>
        failing(404, () => ({ workspace: ctx.workspaces.activate(params.workspaceId) })),
    );

    router.post('/api/workspaces/{workspaceId}/sync', () =>
        json({ message: 'Cloud sync is not available in this version yet.' }, 422),
    );

    router.post('/api/workspaces/{workspaceId}/show-on-disk', ({ params, input }) =>
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
                    throw new WorkspaceError('The workspace database was not found on this device.');
                }

                ctx.host.showItemInFolder(database);
            }

            return null;
        }),
    );
}
