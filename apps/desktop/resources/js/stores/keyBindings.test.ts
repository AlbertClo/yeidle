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
            },
            body: JSON.stringify({ bindings: next }),
        });
    });
});
