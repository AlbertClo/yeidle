import { afterEach, describe, expect, it } from 'vitest';

import { Meta } from '../../db/meta';
import { createPage } from '../../documents/testing';
import { registerKeyBindingRoutes } from '../controllers/keyBindings';
import { NavigationHistoryStore } from '../services/navigationHistory';
import { Pins } from '../services/pins';
import { LOCAL_USER_DOCUMENT_ID, UserDocument } from '../services/userDocument';
import { call, Router, testContext } from '../testing';

import { signInDevice } from './fakeCloud';
import { cloudFor } from './index';
import { cloudProfileKey } from './profile';

const CLOUD = 'http://cloud.test';

const devices: ReturnType<typeof testContext>[] = [];

afterEach(() => {
    while (devices.length > 0) {
        devices.pop()!.cleanup();
    }
});

/** A fake cloud that records preference uploads and can go offline. */
function fakeAccountCloud() {
    const state = {
        offline: false,
        keyBindings: {} as Record<string, unknown>,
        puts: 0,
    };
    const respond = (body: unknown) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });

    const fetch = async (input: string, init?: RequestInit) => {
        if (state.offline) {
            throw new TypeError('fetch failed');
        }

        const { pathname } = new URL(input);

        if (pathname === '/api/workspaces') {
            return respond({ workspaces: [] });
        }

        if (pathname === '/api/user/preferences') {
            if (init?.method === 'PUT') {
                state.puts++;
                state.keyBindings = JSON.parse(String(init.body)).key_bindings;
            }

            return respond({ key_bindings: state.keyBindings });
        }

        return new Response('{}', { status: 404 });
    };

    return { state, fetch };
}

function signedIn(cloud: ReturnType<typeof fakeAccountCloud>, userId = '7') {
    const ctx = testContext();
    devices.push(ctx);
    ctx.host.cloudFetch = cloud.fetch;
    signInDevice(ctx, userId, CLOUD);

    return ctx;
}

const accountFile = (ctx: ReturnType<typeof testContext>) =>
    JSON.parse(
        ctx.host.files.readText(
            ctx.host.files.join(ctx.host.dataDirectory, 'cloud-account.json'),
        ),
    ).account;

/** Lets background work started by a request finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('cloud profile', () => {
    it('is local when signed out and the cloud user when signed in', () => {
        const local = testContext();
        devices.push(local);
        expect(cloudProfileKey(local)).toBe('local');

        expect(cloudProfileKey(signedIn(fakeAccountCloud(), '7'))).toBe(
            'cloud:7',
        );
    });

    it('falls back to the user the workspace is paired with', () => {
        const ctx = testContext();
        devices.push(ctx);
        new Meta(ctx.db()).set('cloud_user_id', '9');

        expect(cloudProfileKey(ctx)).toBe('cloud:9');
    });

    it('keeps navigation history per user', () => {
        const ctx = signedIn(fakeAccountCloud(), '7');
        new NavigationHistoryStore(ctx).save(
            '01a1dbb0-0000-7000-8000-000000000001',
            {
                url: '/pages',
                scroll_top: 0,
                visited_at: new Date().toISOString(),
                last_visited_at: new Date().toISOString(),
            },
            true,
        );
        expect(
            ctx.db().all('SELECT DISTINCT user_key FROM navigation_locations'),
        ).toEqual([{ user_key: 'cloud:7' }]);
    });

    it('moves pins made before sign-in into the user document', () => {
        const ctx = testContext();
        devices.push(ctx);
        const pageId = createPage(ctx.documents(), 'Pinned before sign-in');
        new Pins(ctx).add(pageId);
        expect(new UserDocument(ctx).id()).toBe(LOCAL_USER_DOCUMENT_ID);

        signInDevice(ctx, '7', CLOUD);

        expect(new UserDocument(ctx).id()).toBe('user:7');
        expect(new Pins(ctx).listing().map((page) => page.id)).toEqual([
            pageId,
        ]);
        expect(
            ctx
                .db()
                .get<{ n: number }>(
                    "SELECT COUNT(*) AS n FROM document_updates WHERE document_id = 'user:7'",
                )!.n,
        ).toBe(1);
    });
});

describe('key bindings in the cloud account', () => {
    it('uploads a changed shortcut', async () => {
        const cloud = fakeAccountCloud();
        const ctx = signedIn(cloud);
        const router = new Router();
        registerKeyBindingRoutes(router, ctx);

        const response = await call(router, 'PUT', '/api/key-bindings', {
            bindings: { 'all-pages': 'Mod+Shift+A' },
        });
        await settle();

        expect(response.status).toBe(200);
        expect(cloud.state.keyBindings).toEqual({ 'all-pages': 'Mod+Shift+A' });
        expect(accountFile(ctx).preferences_dirty).toBe(false);
    });

    it('saves offline and uploads on the next refresh', async () => {
        const cloud = fakeAccountCloud();
        const ctx = signedIn(cloud);
        const router = new Router();
        registerKeyBindingRoutes(router, ctx);
        cloud.state.offline = true;

        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: { 'all-pages': 'Mod+Shift+B' },
                })
            ).status,
        ).toBe(200);
        await settle();
        expect(accountFile(ctx).preferences_dirty).toBe(true);

        cloud.state.offline = false;
        await cloudFor(ctx).account.refresh();

        expect(cloud.state.puts).toBe(1);
        expect(cloud.state.keyBindings).toEqual({ 'all-pages': 'Mod+Shift+B' });
        expect(accountFile(ctx).preferences_dirty).toBe(false);
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'all-pages'
            ],
        ).toBe('Mod+Shift+B');
    });

    it('takes the cloud copy on refresh when nothing local is pending', async () => {
        const cloud = fakeAccountCloud();
        cloud.state.keyBindings = { 'all-pages': 'Mod+Shift+C' };
        const ctx = signedIn(cloud);
        const router = new Router();
        registerKeyBindingRoutes(router, ctx);

        await cloudFor(ctx).account.refresh();

        expect(cloud.state.puts).toBe(0);
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'all-pages'
            ],
        ).toBe('Mod+Shift+C');
    });
});
