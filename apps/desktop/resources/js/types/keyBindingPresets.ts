import { defaultKeyBindings, resolvedKeyBinding } from './keyBindings';
import type { KeyBindingCommand, KeyBindings } from './keyBindings';
import { keyboardPlatform } from './keyboardPlatform';
import type { KeyboardPlatform } from './keyboardPlatform';

export const KEY_BINDING_PRESETS = [
    { id: 'yeidle', label: 'Yeidle' },
    { id: 'roam', label: 'Roam Research' },
    { id: 'logseq', label: 'Logseq' },
    { id: 'obsidian', label: 'Obsidian' },
] as const;

export type KeyBindingPreset = (typeof KEY_BINDING_PRESETS)[number]['id'];

// Only verified equivalents are mapped. Other actions retain Yeidle defaults.
// Roam: https://roamdocs.fyi/help/key-commands and /help/navigation
// Logseq: https://github.com/logseq/logseq/blob/0.10.15/src/main/frontend/modules/shortcut/config.cljs
// Obsidian: https://help.obsidian.md/plugins/command-palette,
// /plugins/quick-switcher and https://obsidian.md/changelog/2022-10-13-desktop-v1.0.0/
export function keyBindingsFromPreset(
    preset: KeyBindingPreset,
    platform: KeyboardPlatform = keyboardPlatform(),
): KeyBindings {
    const defaults = defaultKeyBindings(platform);
    const mac = platform === 'mac';
    const roamMoves = {
        'move-node-up': mac ? 'Mod+Shift+ArrowUp' : 'Alt+Shift+ArrowUp',
        'move-node-down': mac ? 'Mod+Shift+ArrowDown' : 'Alt+Shift+ArrowDown',
    };
    let overrides: Partial<KeyBindings> = {};

    if (preset === 'roam') {
        overrides = {
            ...roamMoves,
            'command-palette': 'Mod+P',
            'daily-notes': mac ? 'Ctrl+Shift+D' : 'Alt+D',
            'previous-daily-note': 'Ctrl+Alt+P',
            'next-daily-note': 'Ctrl+Alt+N',
            'toggle-left-sidebar': 'Mod+Backslash',
            'find-page': 'Mod+U',
            'toggle-checkbox': 'Mod+Enter',
            'collapse-node': 'Mod+ArrowUp',
            'expand-node': 'Mod+ArrowDown',
            'follow-link': 'Ctrl+O',
            back: 'Mod+ArrowLeft',
            forward: 'Mod+ArrowRight',
        };
    } else if (preset === 'logseq') {
        overrides = {
            ...roamMoves,
            'command-palette': 'Mod+Shift+P',
            'all-pages': 'G A',
            'daily-notes': 'G J',
            'previous-daily-note': 'G P',
            'next-daily-note': 'G N',
            'toggle-left-sidebar': 'T L',
            'find-page': 'Mod+K',
            'toggle-pin': 'Mod+Shift+F',
            'toggle-checkbox': 'Mod+Enter',
            'collapse-node': 'Mod+ArrowUp',
            'expand-node': 'Mod+ArrowDown',
            'follow-link': 'Mod+O',
            back: 'Mod+BracketLeft',
            forward: 'Mod+BracketRight',
        };
    } else if (preset === 'obsidian') {
        overrides = {
            'command-palette': 'Mod+P',
            'find-page': 'Mod+O',
            'toggle-checkbox': 'Mod+L',
            // Closest equivalent: Obsidian opens the linked note in a new tab.
            'follow-link': 'Mod+Enter',
        };
    }

    const result = { ...defaults, ...overrides };
    const occupied = new Set(
        Object.values(overrides)
            .filter((value): value is string => value !== null)
            .map((value) => resolvedKeyBinding(value, platform)),
    );

    for (const command of Object.keys(defaults) as KeyBindingCommand[]) {
        const binding = result[command];

        if (
            !(command in overrides) &&
            binding &&
            occupied.has(resolvedKeyBinding(binding, platform))
        ) {
            result[command] = null;
        }
    }

    return result;
}
