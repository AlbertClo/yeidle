import type { AppContext } from '../context';

import { preferencesMap, UserDocument } from './userDocument';

/**
 * Preferences live in the user document's `preferences` map, so new
 * preferences need no schema change.
 */

export const DEFAULT_THEME = 'system';
export const DEFAULT_FONT_FAMILY = 'instrument-sans';
export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 22;

export const FONT_FAMILIES = [
    'instrument-sans',
    'atkinson-hyperlegible',
    'source-serif-4',
    'jetbrains-mono',
] as const;

export const WORKSPACE_STORAGE_OPTIONS = ['local', 'cloud'] as const;

export const THEMES = [
    'dark',
    'light',
    'blush',
    'catppuccin-mocha',
    'catppuccin-latte',
    'gruvbox-dark',
    'gruvbox-light',
    'tokyo-night',
    'cyberpunk',
    'nord',
    'solarized-dark',
    'solarized-light',
    'cobalt2',
    'monokai',
    'paper',
] as const;

export const DARK_THEMES = [
    'dark',
    'catppuccin-mocha',
    'gruvbox-dark',
    'tokyo-night',
    'cyberpunk',
    'nord',
    'solarized-dark',
    'cobalt2',
    'monokai',
] as const;

export type Theme = (typeof THEMES)[number];
export type FontFamily = (typeof FONT_FAMILIES)[number];
export type WorkspaceStorage = (typeof WORKSPACE_STORAGE_OPTIONS)[number];

export type PreferenceListing = {
    theme: Theme | null;
    font_family: FontFamily | null;
    font_size: number | null;
    workspace_storage: WorkspaceStorage | null;
};

function oneOf<T extends string>(
    values: readonly T[],
    value: unknown,
): T | null {
    return typeof value === 'string' &&
        (values as readonly string[]).includes(value)
        ? (value as T)
        : null;
}

function fontSize(value: unknown): number | null {
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_FONT_SIZE &&
        value <= MAX_FONT_SIZE
        ? value
        : null;
}

export class Preferences {
    constructor(private ctx: AppContext) {}

    listing(): PreferenceListing {
        const map = preferencesMap(new UserDocument(this.ctx).read());

        return {
            theme: oneOf(THEMES, map.get('theme')),
            font_family: oneOf(FONT_FAMILIES, map.get('font_family')),
            font_size: fontSize(map.get('font_size')),
            workspace_storage: oneOf(
                WORKSPACE_STORAGE_OPTIONS,
                map.get('workspace_storage'),
            ),
        };
    }

    setTheme(theme: Theme): void {
        this.set({ theme });
    }

    setTypography(fontFamily: FontFamily, size: number): void {
        this.set({ font_family: fontFamily, font_size: size });
    }

    setWorkspaceStorage(storage: WorkspaceStorage): void {
        this.set({ workspace_storage: storage });
    }

    private set(values: Record<string, string | number>): void {
        new UserDocument(this.ctx).edit((doc) => {
            const map = preferencesMap(doc);

            for (const [key, value] of Object.entries(values)) {
                if (map.get(key) !== value) {
                    map.set(key, value);
                }
            }
        }, 'Update preferences');
    }
}
