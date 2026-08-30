export const KEY_BINDING_DEFINITIONS = [
    {
        id: 'command-palette',
        label: 'Open Command Palette',
        defaultBinding: 'Mod+P',
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
        defaultBinding: 'Ctrl+Alt+P',
    },
    {
        id: 'next-daily-note',
        label: 'Open Next Daily Note',
        defaultBinding: 'Ctrl+Alt+N',
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
        defaultBinding: 'Mod+U',
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
        id: 'collapse-all-nodes',
        label: 'Collapse Current Node and Descendants',
        defaultBinding: 'Mod+Shift+ArrowUp',
    },
    {
        id: 'expand-all-nodes',
        label: 'Expand Current Node and Descendants',
        defaultBinding: 'Mod+Shift+ArrowDown',
    },
    {
        id: 'follow-link',
        label: 'Follow Link Under Cursor',
        defaultBinding: 'Ctrl+O',
    },
    {
        id: 'reload',
        label: 'Reload Window',
        defaultBinding: 'Mod+R',
    },
    {
        id: 'back',
        label: 'Navigate Back',
        defaultBinding: 'Mod+ArrowLeft',
    },
    {
        id: 'forward',
        label: 'Navigate Forward',
        defaultBinding: 'Mod+ArrowRight',
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

export const DEFAULT_KEY_BINDINGS = Object.fromEntries(
    KEY_BINDING_DEFINITIONS.map(({ id, defaultBinding }) => [
        id,
        defaultBinding,
    ]),
) as KeyBindings;

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
    if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
        return null;
    }

    let key = keyAliases[event.key] ?? event.key;

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
): boolean {
    if (binding === null) {
        return false;
    }

    const parts = binding.split('+');
    const expectedKey = parts.pop();
    const modifiers = new Set(parts);
    const eventKey = keyFromEvent(event);

    if (eventKey === null || eventKey !== expectedKey) {
        return false;
    }

    const expectsMod = modifiers.has('Mod');

    if (expectsMod) {
        if (!event.ctrlKey && !event.metaKey) {
            return false;
        }
    } else if (
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

    const isMac =
        typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform);
    const displayKeys: Record<string, string> = {
        Backslash: '\\',
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
