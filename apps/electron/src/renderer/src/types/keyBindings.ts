import { keyboardPlatform } from './keyboardPlatform';
import type { KeyboardPlatform } from './keyboardPlatform';

export const KEY_BINDING_DEFINITIONS = [
    {
        id: 'command-palette',
        label: 'Open Command Palette',
        defaultBinding: 'Ctrl+K',
    },
    {
        id: 'new-window',
        label: 'Open New Window',
        defaultBinding: 'Mod+Shift+N',
    },
    {
        id: 'all-pages',
        label: 'Go to All Pages',
        defaultBinding: 'Alt+A',
    },
    {
        id: 'daily-notes',
        label: "Open Today's Daily Note",
        defaultBinding: 'Alt+D',
    },
    {
        id: 'previous-daily-note',
        label: 'Open Previous Daily Note',
        defaultBinding: 'Ctrl+Shift+BracketLeft',
    },
    {
        id: 'next-daily-note',
        label: 'Open Next Daily Note',
        defaultBinding: 'Ctrl+Shift+BracketRight',
    },
    {
        id: 'navigation-history',
        label: 'Open Navigation History',
        defaultBinding: 'Mod+H',
    },
    {
        id: 'toggle-left-sidebar',
        label: 'Toggle Left Sidebar',
        defaultBinding: 'Mod+Backslash',
    },
    {
        id: 'find-page',
        label: 'Find or Create Page',
        defaultBinding: 'Alt+E',
    },
    {
        id: 'toggle-pin',
        label: 'Pin or Unpin Current Page',
        defaultBinding: 'Alt+P',
    },
    {
        id: 'pinned-item-1',
        label: 'Open Pinned Item 1',
        defaultBinding: 'Alt+1',
    },
    {
        id: 'pinned-item-2',
        label: 'Open Pinned Item 2',
        defaultBinding: 'Alt+2',
    },
    {
        id: 'pinned-item-3',
        label: 'Open Pinned Item 3',
        defaultBinding: 'Alt+3',
    },
    {
        id: 'pinned-item-4',
        label: 'Open Pinned Item 4',
        defaultBinding: 'Alt+4',
    },
    {
        id: 'pinned-item-5',
        label: 'Open Pinned Item 5',
        defaultBinding: 'Alt+5',
    },
    {
        id: 'pinned-item-6',
        label: 'Open Pinned Item 6',
        defaultBinding: 'Alt+6',
    },
    {
        id: 'pinned-item-7',
        label: 'Open Pinned Item 7',
        defaultBinding: 'Alt+7',
    },
    {
        id: 'pinned-item-8',
        label: 'Open Pinned Item 8',
        defaultBinding: 'Alt+8',
    },
    {
        id: 'pinned-item-9',
        label: 'Open Pinned Item 9',
        defaultBinding: 'Alt+9',
    },
    {
        id: 'pinned-item-10',
        label: 'Open Pinned Item 10',
        defaultBinding: 'Alt+0',
    },
    {
        id: 'toggle-checkbox',
        label: 'Cycle Checklist State',
        defaultBinding: 'Mod+Enter',
    },
    {
        id: 'edit-node-raw',
        label: 'Toggle Raw Markdown for Current Node',
        defaultBinding: 'Mod+Shift+M',
    },
    {
        id: 'collapse-node',
        label: 'Collapse Current Node',
        defaultBinding: 'Mod+ArrowUp',
    },
    {
        id: 'expand-node',
        label: 'Expand Current Node',
        defaultBinding: 'Mod+ArrowDown',
    },
    {
        id: 'move-node-up',
        label: 'Move Current Node Up',
        defaultBinding: 'Alt+Shift+ArrowUp',
    },
    {
        id: 'move-node-down',
        label: 'Move Current Node Down',
        defaultBinding: 'Alt+Shift+ArrowDown',
    },
    {
        id: 'collapse-all-nodes',
        label: 'Collapse Current Node and Descendants',
        defaultBinding: 'Ctrl+Shift+Minus',
    },
    {
        id: 'expand-all-nodes',
        label: 'Expand Current Node and Descendants',
        defaultBinding: 'Ctrl+Shift+Plus',
    },
    {
        id: 'follow-link',
        label: 'Follow Link Under Cursor',
        defaultBinding: 'Ctrl+Q',
    },
    {
        id: 'reload',
        label: 'Reload Window',
        defaultBinding: 'Mod+R',
    },
    {
        id: 'back',
        label: 'Navigate Back',
        defaultBinding: 'Alt+ArrowLeft',
    },
    {
        id: 'forward',
        label: 'Navigate Forward',
        defaultBinding: 'Alt+ArrowRight',
    },
] as const;

export type KeyBindingCommand = (typeof KEY_BINDING_DEFINITIONS)[number]['id'];

export const PINNED_ITEM_COMMANDS = [
    'pinned-item-1',
    'pinned-item-2',
    'pinned-item-3',
    'pinned-item-4',
    'pinned-item-5',
    'pinned-item-6',
    'pinned-item-7',
    'pinned-item-8',
    'pinned-item-9',
    'pinned-item-10',
] as const satisfies readonly KeyBindingCommand[];

export type KeyBindings = Record<KeyBindingCommand, string | null>;

const MAC_DEFAULT_OVERRIDES: Partial<KeyBindings> = {
    'command-palette': 'Mod+Shift+P',
    'all-pages': 'Mod+Shift+L',
    'daily-notes': 'Ctrl+Shift+D',
    'previous-daily-note': 'Mod+Alt+P',
    'next-daily-note': 'Mod+Alt+N',
    'navigation-history': 'Mod+Shift+H',
    'find-page': 'Mod+Shift+F',
    'toggle-pin': 'Mod+Shift+B',
    'pinned-item-1': 'Mod+1',
    'pinned-item-2': 'Mod+2',
    'pinned-item-3': 'Mod+3',
    'pinned-item-4': 'Mod+4',
    'pinned-item-5': 'Mod+5',
    'pinned-item-6': 'Mod+6',
    'pinned-item-7': 'Mod+7',
    'pinned-item-8': 'Mod+8',
    'pinned-item-9': 'Mod+9',
    'pinned-item-10': 'Mod+0',
    'collapse-node': 'Mod+Alt+ArrowUp',
    'expand-node': 'Mod+Alt+ArrowDown',
    'collapse-all-nodes': 'Mod+Alt+Shift+ArrowUp',
    'expand-all-nodes': 'Mod+Alt+Shift+ArrowDown',
    'move-node-up': 'Ctrl+Meta+ArrowUp',
    'move-node-down': 'Ctrl+Meta+ArrowDown',
    'follow-link': 'Mod+O',
    back: 'Mod+BracketLeft',
    forward: 'Mod+BracketRight',
};

export function defaultKeyBindings(
    platform: KeyboardPlatform = keyboardPlatform(),
): KeyBindings {
    return {
        ...Object.fromEntries(
            KEY_BINDING_DEFINITIONS.map(({ id, defaultBinding }) => [
                id,
                defaultBinding,
            ]),
        ),
        ...(platform === 'mac' ? MAC_DEFAULT_OVERRIDES : {}),
    } as KeyBindings;
}

export const DEFAULT_KEY_BINDINGS = defaultKeyBindings();

export function resolvedKeyBinding(
    binding: string,
    platform: KeyboardPlatform = keyboardPlatform(),
): string {
    return binding
        .split(' ')
        .map((stroke) =>
            stroke
                .split('+')
                .map((part) =>
                    part === 'Mod'
                        ? platform === 'mac'
                            ? 'Meta'
                            : 'Ctrl'
                        : part,
                )
                .join('+'),
        )
        .join(' ');
}

const keyAliases: Record<string, string> = {
    ' ': 'Space',
    '+': 'Plus',
    '-': 'Minus',
    '=': 'Equal',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    '\\': 'Backslash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '`': 'Backquote',
};

const namedKeys = new Set([
    'Enter',
    'Tab',
    'Space',
    'Backspace',
    'Delete',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Plus',
    'Minus',
    'Equal',
    'Comma',
    'Period',
    'Slash',
    'Backslash',
    'Semicolon',
    'Quote',
    'BracketLeft',
    'BracketRight',
    'Backquote',
]);

function keyFromEvent(event: KeyboardEvent): string | null {
    if (event.isComposing || event.getModifierState?.('AltGraph')) {
        return null;
    }

    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
        return null;
    }

    let key = keyAliases[event.key] ?? event.key;

    // Shift can turn punctuation/digits into an otherwise unsupported symbol
    // (for example, [ becomes {). Use the underlying key for those shortcuts,
    // keeping existing character aliases such as Plus unchanged.
    if (
        event.shiftKey &&
        event.key.length === 1 &&
        !keyAliases[event.key] &&
        !/^[a-z0-9]$/i.test(event.key)
    ) {
        if (namedKeys.has(event.code)) {
            key = event.code;
        } else if (/^Digit[0-9]$/.test(event.code)) {
            key = event.code.slice(5);
        }
    }

    // Option can produce a symbol instead of the underlying letter/digit.
    // Only fall back for modified shortcuts; ordinary typing stays untouched.
    if (
        event.altKey &&
        !/^[a-z0-9]$/i.test(key) &&
        /^(Key[A-Z]|Digit[0-9])$/.test(event.code)
    ) {
        key = event.code.replace(/^(Key|Digit)/, '');
    }

    if (/^[a-z0-9]$/i.test(key)) {
        key = key.toUpperCase();
    }

    const functionKey = /^F(?:[1-9]|1[0-2])$/.test(key);

    if (!functionKey && !namedKeys.has(key) && !/^[A-Z0-9]$/.test(key)) {
        return null;
    }

    return key;
}

export function keyBindingFromEvent(event: KeyboardEvent): string | null {
    const key = keyFromEvent(event);

    if (key === null) {
        return null;
    }

    const functionKey = /^F(?:[1-9]|1[0-2])$/.test(key);

    const modifiers = [
        event.ctrlKey ? 'Ctrl' : null,
        event.metaKey ? 'Meta' : null,
        event.altKey ? 'Alt' : null,
        event.shiftKey ? 'Shift' : null,
    ].filter((modifier): modifier is string => modifier !== null);

    if (modifiers.length === 0 && !functionKey) {
        return null;
    }

    return [...modifiers, key].join('+');
}

export function eventMatchesKeyBinding(
    event: KeyboardEvent,
    binding: string | null,
    platform: KeyboardPlatform = keyboardPlatform(),
): boolean {
    if (binding === null) {
        return false;
    }

    const parts = resolvedKeyBinding(binding, platform).split('+');
    const expectedKey = parts.pop();
    const modifiers = new Set(parts);
    const eventKey = keyFromEvent(event);

    if (eventKey === null || eventKey !== expectedKey) {
        return false;
    }

    if (
        event.ctrlKey !== modifiers.has('Ctrl') ||
        event.metaKey !== modifiers.has('Meta')
    ) {
        return false;
    }

    return (
        event.altKey === modifiers.has('Alt') &&
        event.shiftKey === modifiers.has('Shift')
    );
}

export function formatKeyBinding(binding: string | null): string {
    if (binding === null) {
        return 'Unassigned';
    }

    if (binding.includes(' ')) {
        return binding.split(' ').map(formatKeyBinding).join(' then ');
    }

    const isMac = keyboardPlatform() === 'mac';
    const displayKeys: Record<string, string> = {
        Backslash: '\\',
        BracketLeft: '[',
        BracketRight: ']',
    };

    return binding
        .split('+')
        .map((part) => {
            if (part === 'Mod') {
                return isMac ? '⌘' : 'Ctrl';
            }

            if (part === 'Ctrl') {
                return 'Ctrl';
            }

            if (part === 'Meta') {
                return isMac ? '⌘' : 'Meta';
            }

            if (part === 'Alt') {
                return isMac ? '⌥' : 'Alt';
            }

            if (part === 'Shift') {
                return isMac ? '⇧' : 'Shift';
            }

            return displayKeys[part] ?? part.replace('Arrow', '');
        })
        .join('+');
}
