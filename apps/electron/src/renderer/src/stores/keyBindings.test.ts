import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_KEY_BINDINGS } from '../types/keyBindings';
import {
    bindingFor,
    keyBindings,
    loadKeyBindings,
    saveKeyBindings,
} from './keyBindings';

describe('key binding store', () => {
    beforeEach(() => {
        keyBindings.value = { ...DEFAULT_KEY_BINDINGS };
        vi.restoreAllMocks();
    });

    it('loads account bindings', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    bindings: {
                        ...DEFAULT_KEY_BINDINGS,
                        'all-pages': 'Alt+2',
                    },
                    defaults: DEFAULT_KEY_BINDINGS,
                }),
                { status: 200 },
            ),
        );

        await loadKeyBindings(true);

        expect(bindingFor('all-pages')).toBe('Alt+2');
    });

    it('saves and immediately publishes bindings', async () => {
        const next = {
            ...DEFAULT_KEY_BINDINGS,
            'command-palette': 'Mod+Shift+P',
        };
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    bindings: next,
                    defaults: DEFAULT_KEY_BINDINGS,
                }),
                { status: 200 },
            ),
        );

        await saveKeyBindings(next);

        expect(bindingFor('command-palette')).toBe('Mod+Shift+P');
        expect(fetchMock).toHaveBeenCalledWith('/api/key-bindings', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-Yeidle-Keyboard-Platform': 'other',
            },
            body: JSON.stringify({ bindings: next }),
        });
    });
});

describe('shortcut hints', () => {
    it('shows shortcuts where there is a keyboard and none on touch-only devices', async () => {
        const store = await import('./keyBindings');
        expect(store.withShortcut('Back', 'back')).toMatch(/^Back \(.+\)$/);

        vi.resetModules();
        vi.stubGlobal('matchMedia', (query: string) => ({
            matches: query === '(hover: none) and (pointer: coarse)',
        }));

        try {
            const touch = await import('./keyBindings');
            expect(touch.keyboardShortcutsAvailable).toBe(false);
            expect(touch.bindingLabel('back')).toBe('');
            expect(touch.withShortcut('Back', 'back')).toBe('Back');
        } finally {
            vi.unstubAllGlobals();
            vi.resetModules();
        }
    });
});
