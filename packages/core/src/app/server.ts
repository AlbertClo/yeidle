import { Inertia } from '../http/inertia';
import type { InertiaPage } from '../http/inertia';
import { Router } from '../http/router';

import type { AppContext } from './context';
import { registerCloudRoutes } from './controllers/cloud';
import { registerDocumentRoutes } from './controllers/documents';
import { registerKeyBindingRoutes } from './controllers/keyBindings';
import { registerMediaRoutes } from './controllers/media';
import { registerNavigationHistoryRoutes } from './controllers/navigationHistory';
import { registerPageRoutes } from './controllers/pages';
import { registerSystemNodeRoutes } from './controllers/systemNodes';
import { registerWebRoutes } from './controllers/web';
import { registerWorkspaceRoutes } from './controllers/workspaces';
import { DARK_THEMES, PreferenceNodes } from './services/preferences';

export type Appearance = { theme: string; dark: boolean };

export type ServerOptions = {
    version: string;
    /** The HTML document for a first visit, with the page object and theme. */
    renderHtml: (page: InertiaPage, appearance: Appearance) => string;
};

/** Every route the app answers: the JSON API and the Inertia pages. */
export function createAppServer(ctx: AppContext, options: ServerOptions): Router {
    const router = new Router();
    const inertia = new Inertia({
        version: options.version,
        sharedProps: () => ({
            name: 'Yeidle',
            appVersion: ctx.host.appVersion,
            auth: { user: null },
            sidebarOpen: ctx.settings.get<boolean>('sidebar_open') ?? true,
        }),
        renderHtml: (page) => {
            const theme = new PreferenceNodes(ctx).listing().theme ?? 'system';

            return options.renderHtml(page, {
                theme,
                dark: (DARK_THEMES as readonly string[]).includes(theme),
            });
        },
    });

    registerDocumentRoutes(router, ctx);
    registerPageRoutes(router, ctx);
    registerSystemNodeRoutes(router, ctx);
    registerMediaRoutes(router, ctx);
    registerKeyBindingRoutes(router, ctx);
    registerNavigationHistoryRoutes(router, ctx);
    registerWorkspaceRoutes(router, ctx);
    registerCloudRoutes(router, ctx);
    registerWebRoutes(router, ctx, inertia);

    return router;
}
