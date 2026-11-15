import { cloudProfileKey } from '../cloud/profile';
import type { AppContext } from '../context';

/**
 * User keyboard shortcuts, stored in app-wide settings (not the workspace
 * database) as per-profile overrides of the platform defaults.
 */

export type KeyboardPlatform = 'mac' | 'other';

export type KeyBindingListing = {
    bindings: Record<string, string | null>;
    defaults: Record<string, string>;
};

type Profile = { key_bindings?: Record<string, string | null> };
type State = { version: number; profiles: Record<string, Profile> };

export class KeyBindingError extends Error {}

const SETTINGS_KEY = 'key_bindings';
const VERSION = 1;

export const DEFAULT_KEY_BINDINGS: Record<string, string> = {
    'command-palette': 'Ctrl+K',
    'all-pages': 'Alt+A',
    'daily-notes': 'Alt+D',
    'previous-daily-note': 'Ctrl+Shift+BracketLeft',
    'next-daily-note': 'Ctrl+Shift+BracketRight',
    'navigation-history': 'Mod+H',
    'toggle-left-sidebar': 'Mod+Backslash',
    'find-page': 'Alt+E',
    'toggle-pin': 'Alt+P',
    'pinned-item-1': 'Alt+1',
    'pinned-item-2': 'Alt+2',
    'pinned-item-3': 'Alt+3',
    'pinned-item-4': 'Alt+4',
    'pinned-item-5': 'Alt+5',
    'pinned-item-6': 'Alt+6',
    'pinned-item-7': 'Alt+7',
    'pinned-item-8': 'Alt+8',
    'pinned-item-9': 'Alt+9',
    'pinned-item-10': 'Alt+0',
    'toggle-checkbox': 'Mod+Enter',
    'edit-node-raw': 'Mod+Shift+M',
    'collapse-node': 'Mod+ArrowUp',
    'expand-node': 'Mod+ArrowDown',
    'move-node-up': 'Alt+Shift+ArrowUp',
    'move-node-down': 'Alt+Shift+ArrowDown',
    'collapse-all-nodes': 'Ctrl+Shift+Minus',
    'expand-all-nodes': 'Ctrl+Shift+Plus',
    'follow-link': 'Ctrl+Q',
    reload: 'Mod+R',
    back: 'Alt+ArrowLeft',
    forward: 'Alt+ArrowRight',
};

const MAC_DEFAULT_OVERRIDES: Record<string, string> = {
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

const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];

const KEYS = [
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
];

const isCommand = (command: string): boolean =>
    Object.hasOwn(DEFAULT_KEY_BINDINGS, command);

export function defaultKeyBindings(isMac: boolean): Record<string, string> {
    return { ...DEFAULT_KEY_BINDINGS, ...(isMac ? MAC_DEFAULT_OVERRIDES : {}) };
}

/** Bindings belong to the signed-in cloud user (`cloud:<id>`), else `local`. */
export function keyBindingProfileKey(ctx: AppContext): string {
    return cloudProfileKey(ctx);
}

export class UserKeyBindings {
    constructor(
        private ctx: AppContext,
        private profileKey: () => string = () => keyBindingProfileKey(ctx),
    ) {}

    listing(platform: KeyboardPlatform | null = null): KeyBindingListing {
        const state = this.read();
        const defaults = defaultKeyBindings(this.isMac(platform));

        return {
            bindings: {
                ...defaults,
                ...(this.profile(state).key_bindings ?? {}),
            },
            defaults,
        };
    }

    /** Applies changes on top of the current bindings; throws KeyBindingError when invalid. */
    replace(
        bindings: Record<string, unknown>,
        platform: KeyboardPlatform | null = null,
    ): KeyBindingListing {
        const state = this.read();
        const profileKey = this.profileKey();
        const isMac = this.isMac(platform);
        const defaults = defaultKeyBindings(isMac);
        const current: Record<string, string | null> = {
            ...defaults,
            ...(this.profile(state).key_bindings ?? {}),
        };

        for (const [command, binding] of Object.entries(bindings)) {
            if (!isCommand(command)) {
                throw new KeyBindingError(
                    `Unknown shortcut command [${command}].`,
                );
            }

            if (binding !== null && typeof binding !== 'string') {
                throw new KeyBindingError(
                    'Shortcut bindings must be strings or null.',
                );
            }

            current[command] = binding === null ? null : normalize(binding);
        }

        const modifier = isMac ? 'Meta' : 'Ctrl';
        const assigned = Object.values(current)
            .filter((binding): binding is string => typeof binding === 'string')
            .map((binding) => binding.replace(/\bMod(?=\+)/g, modifier));

        if (assigned.length !== new Set(assigned).size) {
            throw new KeyBindingError(
                'Each shortcut must use a unique key combination.',
            );
        }

        for (const binding of assigned) {
            for (const other of assigned) {
                if (other.startsWith(`${binding} `)) {
                    throw new KeyBindingError(
                        'A shortcut cannot also be the start of another shortcut.',
                    );
                }
            }
        }

        const overrides: Record<string, string | null> = {};

        for (const [command, binding] of Object.entries(current)) {
            if (binding !== defaults[command]) {
                overrides[command] = binding;
            }
        }

        state.profiles[profileKey] = { key_bindings: overrides };
        this.write(state);

        return { bindings: current, defaults };
    }

    overrides(): Record<string, string | null> {
        return this.profile(this.read()).key_bindings ?? {};
    }

    /** Replaces the profile's overrides with the cloud copy, skipping anything invalid. */
    importCloud(bindings: Record<string, unknown>): KeyBindingListing {
        const state = this.read();
        const normalized: Record<string, string | null> = {};

        for (const [command, binding] of Object.entries(bindings)) {
            if (
                !isCommand(command) ||
                (binding !== null && typeof binding !== 'string')
            ) {
                continue;
            }

            normalized[command] = binding === null ? null : normalize(binding);
        }

        state.profiles[this.profileKey()] = { key_bindings: normalized };
        this.write(state);

        return this.listing();
    }

    private isMac(platform: KeyboardPlatform | null): boolean {
        return platform === null
            ? this.ctx.host.platform === 'darwin'
            : platform === 'mac';
    }

    /** A signed-in profile adopts the local profile the first time it is used. */
    private profile(state: State): Profile {
        const profileKey = this.profileKey();

        if (
            profileKey !== 'local' &&
            !Object.hasOwn(state.profiles, profileKey) &&
            Object.hasOwn(state.profiles, 'local')
        ) {
            state.profiles[profileKey] = state.profiles.local;
            this.write(state);
        }

        return state.profiles[profileKey] ?? {};
    }

    private read(): State {
        const state = this.ctx.settings.get<unknown>(SETTINGS_KEY);

        if (state === null) {
            return { version: VERSION, profiles: {} };
        }

        if (
            !isRecord(state) ||
            state.version !== VERSION ||
            !isRecord(state.profiles)
        ) {
            throw new Error('The local user preferences are invalid.');
        }

        for (const profile of Object.values(state.profiles)) {
            if (!isRecord(profile) || !isRecord(profile.key_bindings)) {
                throw new Error(
                    'The local user preferences contain an invalid profile.',
                );
            }

            for (const [command, binding] of Object.entries(
                profile.key_bindings,
            )) {
                if (
                    !isCommand(command) ||
                    (binding !== null && typeof binding !== 'string')
                ) {
                    throw new Error(
                        'The local user preferences contain an invalid shortcut.',
                    );
                }
            }
        }

        return state as State;
    }

    private write(state: State): void {
        this.ctx.settings.set(SETTINGS_KEY, state);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalize(binding: string): string {
    const strokes = binding.trim().split(/\s+/);

    if (strokes.length > 1) {
        if (
            strokes.length !== 2 ||
            strokes.some((stroke) => !/^[a-z]$/i.test(stroke))
        ) {
            throw new KeyBindingError(
                'Key sequences must contain two letters, for example G A.',
            );
        }

        return strokes.join(' ').toUpperCase();
    }

    const parts = binding.trim().split('+');
    let key = parts.pop();

    if (key === undefined || key === '') {
        throw new KeyBindingError('The shortcut key combination is invalid.');
    }

    if (/^[a-z0-9]$/i.test(key)) {
        key = key.toUpperCase();
    }

    const functionKey = /^F(?:[1-9]|1[0-2])$/.test(key);

    if (!functionKey && !KEYS.includes(key) && !/^[A-Z0-9]$/.test(key)) {
        throw new KeyBindingError(`Shortcut key [${key}] is not supported.`);
    }

    if (parts.length === 0 && !functionKey) {
        throw new KeyBindingError('Shortcuts must include a modifier key.');
    }

    if (parts.length !== new Set(parts).size) {
        throw new KeyBindingError('A shortcut cannot repeat modifier keys.');
    }

    for (const modifier of parts) {
        if (!MODIFIERS.includes(modifier)) {
            throw new KeyBindingError(
                `Shortcut modifier [${modifier}] is not supported.`,
            );
        }
    }

    if (
        parts.includes('Mod') &&
        (parts.includes('Ctrl') || parts.includes('Meta'))
    ) {
        throw new KeyBindingError('Mod cannot be combined with Ctrl or Meta.');
    }

    return [
        ...MODIFIERS.filter((modifier) => parts.includes(modifier)),
        key,
    ].join('+');
}
