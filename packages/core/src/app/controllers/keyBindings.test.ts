import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultKeyBindings, UserKeyBindings } from '../services/keyBindings';
import { call, Router, testContext } from '../testing';

import { registerKeyBindingRoutes } from './keyBindings';

let ctx: ReturnType<typeof testContext>;
let router: Router;
let profileKey: string;
let keyBindings: UserKeyBindings;

beforeEach(() => {
    ctx = testContext();
    router = new Router();
    profileKey = 'local';
    keyBindings = new UserKeyBindings(ctx, () => profileKey);
    registerKeyBindingRoutes(router, ctx, keyBindings);
});

afterEach(() => ctx.cleanup());

const mac = { 'x-yeidle-keyboard-platform': 'mac' };
const other = { 'x-yeidle-keyboard-platform': 'other' };

describe('key binding routes', () => {
    it('returns defaults and saves overrides outside the workspace database', async () => {
        const listing = await call(router, 'GET', '/api/key-bindings');
        expect(listing.status).toBe(200);
        expect(listing.json.bindings).toMatchObject({
            'command-palette': 'Ctrl+K',
            'find-page': 'Alt+E',
            'previous-daily-note': 'Ctrl+Shift+BracketLeft',
            'next-daily-note': 'Ctrl+Shift+BracketRight',
            'navigation-history': 'Mod+H',
            'toggle-left-sidebar': 'Mod+Backslash',
            'toggle-checkbox': 'Mod+Enter',
            'edit-node-raw': 'Mod+Shift+M',
            'collapse-node': 'Mod+ArrowUp',
            'expand-node': 'Mod+ArrowDown',
            'collapse-all-nodes': 'Ctrl+Shift+Minus',
            'expand-all-nodes': 'Ctrl+Shift+Plus',
            'follow-link': 'Ctrl+Q',
            'pinned-item-1': 'Alt+1',
            'pinned-item-10': 'Alt+0',
        });

        const saved = await call(router, 'PUT', '/api/key-bindings', {
            bindings: { 'command-palette': 'Mod+Shift+P', 'toggle-pin': null },
        });
        expect(saved.status).toBe(200);
        expect(saved.json.bindings['command-palette']).toBe('Mod+Shift+P');
        expect(saved.json.bindings['toggle-pin']).toBeNull();
        expect(saved.json.bindings['all-pages']).toBe('Alt+A');

        expect(ctx.settings.get('key_bindings')).toEqual({
            version: 1,
            profiles: {
                local: {
                    key_bindings: {
                        'command-palette': 'Mod+Shift+P',
                        'toggle-pin': null,
                    },
                },
            },
        });
        expect(
            ctx
                .db()
                .get<{ count: number }>(
                    'SELECT COUNT(*) AS count FROM document_updates',
                )!.count,
        ).toBe(0);
    });

    it('scopes bindings to the cloud user and adopts the shared local profile', async () => {
        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: { 'all-pages': 'Mod+Shift+A' },
                })
            ).status,
        ).toBe(200);

        profileKey = 'cloud:user-a';
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'all-pages'
            ],
        ).toBe('Mod+Shift+A');
        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: { 'all-pages': 'Mod+Shift+B' },
                })
            ).status,
        ).toBe(200);

        profileKey = 'cloud:user-b';
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'all-pages'
            ],
        ).toBe('Mod+Shift+A');

        profileKey = 'cloud:user-a';
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'all-pages'
            ],
        ).toBe('Mod+Shift+B');
    });

    it('rejects unknown, invalid and conflicting bindings', async () => {
        for (const bindings of [
            { unknown: 'Mod+U' },
            { 'all-pages': 'A' },
            { 'all-pages': 'Mod+K' },
        ]) {
            const response = await call(router, 'PUT', '/api/key-bindings', {
                bindings,
            });
            expect(response.status).toBe(422);
            expect(response.json.errors).toHaveProperty('bindings');
        }

        expect(
            (await call(router, 'PUT', '/api/key-bindings', {})).status,
        ).toBe(422);
        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: { 'all-pages': 'Mod+'.repeat(20) + 'A' },
                })
            ).json.errors,
        ).toHaveProperty(['bindings.all-pages']);
    });

    it('uses platform defaults and does not persist mac defaults as customizations', async () => {
        const listing = await call(router, 'GET', '/api/key-bindings', {}, mac);
        expect(listing.json.bindings).toMatchObject({
            'command-palette': 'Mod+Shift+P',
            'collapse-all-nodes': 'Mod+Alt+Shift+ArrowUp',
            'expand-all-nodes': 'Mod+Alt+Shift+ArrowDown',
            'move-node-up': 'Ctrl+Meta+ArrowUp',
            back: 'Mod+BracketLeft',
        });

        // The PHP test sent no header here and relied on the host OS; be explicit
        expect(
            (
                await call(
                    router,
                    'PUT',
                    '/api/key-bindings',
                    { bindings: defaultKeyBindings(true) },
                    mac,
                )
            ).status,
        ).toBe(200);
        expect(keyBindings.overrides()).toEqual({});

        const others = await call(
            router,
            'GET',
            '/api/key-bindings',
            {},
            other,
        );
        expect(others.json.bindings['move-node-up']).toBe('Alt+Shift+ArrowUp');
        expect(others.json.bindings.back).toBe('Alt+ArrowLeft');
    });

    it('saves logseq sequences and rejects modifier alias conflicts', async () => {
        const saved = await call(router, 'PUT', '/api/key-bindings', {
            bindings: { 'all-pages': 'g a', 'daily-notes': 'g j' },
        });
        expect(saved.status).toBe(200);
        expect(saved.json.bindings['all-pages']).toBe('G A');
        expect(
            (await call(router, 'GET', '/api/key-bindings')).json.bindings[
                'daily-notes'
            ],
        ).toBe('G J');

        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: { 'all-pages': 'G A B' },
                })
            ).status,
        ).toBe(422);

        const conflict = await call(
            router,
            'PUT',
            '/api/key-bindings',
            { bindings: { 'all-pages': 'Meta+Shift+P' } },
            mac,
        );
        expect(conflict.status).toBe(422);
        expect(conflict.json.errors).toHaveProperty('bindings');
    });

    it('saves and loads shifted bracket shortcuts', async () => {
        expect(
            (
                await call(router, 'PUT', '/api/key-bindings', {
                    bindings: {
                        'previous-daily-note': 'Ctrl+Shift+BracketLeft',
                        'next-daily-note': 'Ctrl+Shift+BracketRight',
                    },
                })
            ).status,
        ).toBe(200);

        const listing = await call(router, 'GET', '/api/key-bindings');
        expect(listing.json.bindings['previous-daily-note']).toBe(
            'Ctrl+Shift+BracketLeft',
        );
        expect(listing.json.bindings['next-daily-note']).toBe(
            'Ctrl+Shift+BracketRight',
        );
    });

    it('normalizes modifier order and key case', async () => {
        const saved = await call(router, 'PUT', '/api/key-bindings', {
            bindings: { 'all-pages': 'Shift+Alt+x' },
        });
        expect(saved.json.bindings['all-pages']).toBe('Alt+Shift+X');
    });
});
