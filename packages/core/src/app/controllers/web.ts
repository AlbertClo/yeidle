import type { Inertia } from '../../http/inertia';
import type { Router } from '../../http/router';
import { toBase64 } from '../../support/base64';
import type { AppContext } from '../context';
import { allPages, findPage } from '../pages';
import { loadBacklinks } from '../services/backlinks';
import { CollapsedBlocks } from '../services/collapsedBlocks';
import { Pins } from '../services/pins';
import { Preferences } from '../services/preferences';

import { navigationHistoryPageProps } from './navigationHistory';

/** The Inertia pages (what PageWebController and friends rendered). */
export function registerWebRoutes(
    router: Router,
    ctx: AppContext,
    inertia: Inertia,
): void {
    const index =
        (missingPage: boolean) =>
        (context: Parameters<Parameters<Router['get']>[1]>[0]) => {
            const pages = allPages(ctx.db());
            const preferences = new Preferences(ctx).listing();
            const workspace = ctx.workspace();
            const cloudStatus = workspace.record.cloud_status;

            return inertia.render(
                context,
                'Pages/Index',
                {
                    pages,
                    themeSetupRequired: preferences.theme === null,
                    storageSetupRequired:
                        preferences.workspace_storage === null &&
                        cloudStatus === 'local',
                    workspaceCloudStatus: cloudStatus,
                    openDailyNote: context.request.url.pathname === '/',
                    missingPage,
                    databaseRecovered: workspace.recoveredMissingDatabase,
                },
                missingPage ? '/pages' : undefined,
            );
        };

    router.get('/', index(false));
    router.get('/pages', index(false));

    router.get('/pages/{page}', (context) => {
        const page = findPage(ctx.db(), context.params.page);

        if (page === null) {
            // The PHP app redirected with a flash; render the list in place
            return index(true)(context);
        }

        const stored = ctx.documents().store.load(page.id);

        return inertia.render(context, 'Pages/Show', {
            page,
            pinned: new Pins(ctx).isPinned(page.id),
            collapsedBlockIds: new CollapsedBlocks(ctx).ids(),
            backlinks: loadBacklinks(ctx.db(), page.id),
            document: {
                id: stored.id,
                snapshot: stored.snapshot ? toBase64(stored.snapshot) : null,
                updates: stored.updates.map(toBase64),
                seq: stored.seq,
            },
        });
    });

    router.get('/navigation-history', (context) =>
        inertia.render(
            context,
            'NavigationHistory/Index',
            navigationHistoryPageProps(ctx),
        ),
    );
}
