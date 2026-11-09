import { placeholders } from '../../db/database';
import type { Inertia } from '../../http/inertia';
import type { Router } from '../../http/router';
import { toBase64 } from '../../support/base64';
import { uuidv7 } from '../../support/ids';
import { sqlTimestamp } from '../../support/time';
import type { AppContext } from '../context';
import { findNode, isSystemNode, SystemNodes } from '../nodes';
import { loadBacklinks } from '../services/backlinks';
import { CollapsedNodes } from '../services/collapsedNodes';
import { loadNodeTree } from '../services/nodeTree';
import { PinNodes } from '../services/pins';
import { PreferenceNodes } from '../services/preferences';

import { navigationHistoryPageProps } from './navigationHistory';

/** The Inertia pages (what PageWebController and friends rendered). */
export function registerWebRoutes(router: Router, ctx: AppContext, inertia: Inertia): void {
    const index = (missingPage: boolean) =>
        (context: Parameters<Parameters<Router['get']>[1]>[0]) => {
            const db = ctx.db();
            const rootIds = SystemNodes.ROOT_IDS;
            const pages = db.all(
                `SELECT id, content, page_type, daily_note_date, created_at FROM nodes
                 WHERE parent_id IS NULL AND deleted_at IS NULL AND id NOT IN (${placeholders(rootIds.length)})
                 ORDER BY modified_hlc DESC, id DESC`,
                rootIds,
            );
            const preferences = new PreferenceNodes(ctx).listing();
            const workspace = ctx.workspace();
            const cloudStatus = workspace.record.cloud_status;

            return inertia.render(
                context,
                'Pages/Index',
                {
                    pages,
                    themeSetupRequired: preferences.theme === null,
                    storageSetupRequired:
                        preferences.workspace_storage === null && cloudStatus === 'local',
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

    router.get('/pages/{node}', (context) => {
        const db = ctx.db();
        const page = findNode(db, context.params.node);

        if (page === null) {
            // The PHP app redirected with a flash; render the list in place
            return index(true)(context);
        }

        if (isSystemNode(db, page)) {
            return inertia.render(context, 'Pages/Index', {}, '/pages');
        }

        const stored = ctx.documents().store.load(page.id);
        const collapsed = new CollapsedNodes(ctx).listing();
        db.run('INSERT INTO page_visits (id, node_id, visited_at) VALUES (?, ?, ?)', [
            uuidv7(),
            page.id,
            sqlTimestamp(),
        ]);

        return inertia.render(context, 'Pages/Show', {
            page: loadNodeTree(db, page.id),
            pinned: new PinNodes(ctx).isPinned(page.id),
            collapsedNodeIds: collapsed.node_ids,
            collapsedNodesRootId: collapsed.root_id,
            backlinks: loadBacklinks(db, page.id),
            document: {
                id: stored.id,
                snapshot: stored.snapshot ? toBase64(stored.snapshot) : null,
                updates: stored.updates.map(toBase64),
                seq: stored.seq,
            },
        });
    });

    router.get('/navigation-history', (context) =>
        inertia.render(context, 'NavigationHistory/Index', navigationHistoryPageProps(ctx)),
    );
}
