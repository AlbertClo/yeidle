import { describe, expect, it } from 'vitest';
import {
    KEY_BINDING_PRESETS,
    keyBindingsFromPreset,
} from './keyBindingPresets';
import {
    defaultKeyBindings,
    resolvedKeyBinding,
    eventMatchesKeyBinding,
} from './keyBindings';

describe('shortcut presets', () => {
    for (const platform of ['mac', 'other'] as const) {
        for (const preset of KEY_BINDING_PRESETS) {
            it(`${preset.label} has no overlapping bindings on ${platform}`, () => {
                const bindings = Object.values(
                    keyBindingsFromPreset(preset.id, platform),
                )
                    .filter((binding): binding is string => binding !== null)
                    .map((binding) => resolvedKeyBinding(binding, platform));
                expect(new Set(bindings).size).toBe(bindings.length);
            });
        }
    }

    it('uses Roam move keys only when choosing the Roam/Logseq preset on Mac', () => {
        expect(defaultKeyBindings('mac')['move-node-up']).toBe(
            'Ctrl+Meta+ArrowUp',
        );
        expect(keyBindingsFromPreset('roam', 'mac')['move-node-up']).toBe(
            'Mod+Shift+ArrowUp',
        );
        expect(keyBindingsFromPreset('logseq', 'other')['move-node-down']).toBe(
            'Alt+Shift+ArrowDown',
        );
    });
    it('keeps the Mac Yeidle defaults separate from the Windows/Linux defaults', () => {
        expect(keyBindingsFromPreset('yeidle', 'mac')).toMatchObject({
            'command-palette': 'Mod+Shift+P',
            'find-page': 'Mod+Shift+F',
            'previous-daily-note': 'Mod+Alt+P',
            'next-daily-note': 'Mod+Alt+N',
            'collapse-all-nodes': 'Mod+Alt+Shift+ArrowUp',
            'expand-all-nodes': 'Mod+Alt+Shift+ArrowDown',
            'follow-link': 'Mod+O',
        });
        expect(keyBindingsFromPreset('yeidle', 'other')).toEqual(
            defaultKeyBindings('other'),
        );
    });
    it('maps Logseq sequences and Obsidian quick switcher without a follow-link collision', () => {
        expect(keyBindingsFromPreset('logseq', 'mac')['all-pages']).toBe('G A');
        const obsidian = keyBindingsFromPreset('obsidian', 'mac');
        expect(obsidian['find-page']).toBe('Mod+O');
        expect(obsidian['follow-link']).toBe('Mod+Enter');
        expect(obsidian['toggle-checkbox']).toBe('Mod+L');
    });
    it('leaves native Mac text-navigation, print, underline and hide keys unassigned by default', () => {
        const keys = [
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'h',
            'p',
            'u',
            'q',
        ];
        const defaults = Object.values(defaultKeyBindings('mac'));

        for (const key of keys) {
            const event = {
                key,
                ctrlKey: false,
                metaKey: true,
                altKey: false,
                shiftKey: false,
            } as KeyboardEvent;
            expect(
                defaults.some((binding) =>
                    eventMatchesKeyBinding(event, binding, 'mac'),
                ),
            ).toBe(false);

            if (key.startsWith('Arrow')) {
                const selectionEvent = {
                    ...event,
                    shiftKey: true,
                } as KeyboardEvent;
                expect(
                    defaults.some((binding) =>
                        eventMatchesKeyBinding(selectionEvent, binding, 'mac'),
                    ),
                ).toBe(false);
            }
        }
    });
});
