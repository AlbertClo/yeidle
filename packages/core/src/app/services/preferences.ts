import type { NodeChange } from '../../loro/nodeOps';
import type { AppContext } from '../context';
import { findNode, SystemNodes } from '../nodes';

import {
    activeAccountRoot,
    containerChanges,
    deleteChange,
    entryFields,
    entryId,
    setChange,
} from './accountRoots';
import { positionAt } from './positions';

/**
 * Preferences live in the normal synced node graph: hidden workspace root ->
 * hidden account root -> preference entries. Entry ids are UUIDv5-derived
 * from the preference key and their content is the value, so new preferences
 * need no schema change.
 */

export const THEME_KEY = 'theme';
export const FONT_FAMILY_KEY = 'font-family';
export const FONT_SIZE_KEY = 'font-size';
export const WORKSPACE_STORAGE_KEY = 'workspace-storage';

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
    root_id: string;
    theme: Theme | null;
    font_family: FontFamily | null;
    font_size: number | null;
    workspace_storage: WorkspaceStorage | null;
};

function oneOf<T extends string>(
    values: readonly T[],
    value: string | undefined,
): T | null {
    return value !== undefined && (values as readonly string[]).includes(value)
        ? (value as T)
        : null;
}

/** PHP's FILTER_VALIDATE_INT with a range. */
function validInt(
    value: string | undefined,
    min: number,
    max: number,
): number | null {
    const trimmed = value?.trim() ?? '';

    if (!/^[+-]?(0|[1-9]\d*)$/.test(trimmed)) {
        return null;
    }

    const number = Number(trimmed);

    return number >= min && number <= max ? number : null;
}

export class PreferenceNodes {
    static readonly ROOT_ID = SystemNodes.PREFERENCES_ROOT_ID;

    constructor(private ctx: AppContext) {}

    listing(): PreferenceListing {
        const db = this.ctx.db();
        const rootId = this.activeRootId();
        const value = (key: string) =>
            findNode(db, entryId(rootId, key))?.content;

        return {
            root_id: rootId,
            theme: oneOf(THEMES, value(THEME_KEY)),
            font_family: oneOf(FONT_FAMILIES, value(FONT_FAMILY_KEY)),
            font_size: validInt(
                value(FONT_SIZE_KEY),
                MIN_FONT_SIZE,
                MAX_FONT_SIZE,
            ),
            workspace_storage: oneOf(
                WORKSPACE_STORAGE_OPTIONS,
                value(WORKSPACE_STORAGE_KEY),
            ),
        };
    }

    setTheme(theme: string): void {
        this.set([[THEME_KEY, theme, 0]]);
    }

    setTypography(fontFamily: string, fontSize: number): void {
        this.set([
            [FONT_FAMILY_KEY, fontFamily, 1],
            [FONT_SIZE_KEY, String(fontSize), 2],
        ]);
    }

    setWorkspaceStorage(storage: string): void {
        this.set([[WORKSPACE_STORAGE_KEY, storage, 3]]);
    }

    activeRootId(): string {
        return activeAccountRoot(
            this.ctx.db(),
            PreferenceNodes.ROOT_ID,
            (localRootId, cloudRootId) =>
                this.adoptAccountRoot(localRootId, cloudRootId),
        );
    }

    private set(
        entries: [key: string, value: string, position: number][],
    ): void {
        this.ctx.db().transaction(() => {
            const rootId = this.activeRootId();
            const changes: NodeChange[] = containerChanges(
                PreferenceNodes.ROOT_ID,
                rootId,
            );

            for (const [key, value, position] of entries) {
                changes.push(
                    setChange(
                        entryId(rootId, key),
                        rootId,
                        entryFields(rootId, positionAt(position), value),
                    ),
                );
            }

            this.ctx.documents().applyChanges(changes, 'Update preferences');
        });
    }

    private adoptAccountRoot(localRootId: string, cloudRootId: string): void {
        const db = this.ctx.db();

        if (findNode(db, localRootId) === null) {
            return;
        }

        const changes = containerChanges(PreferenceNodes.ROOT_ID, cloudRootId);

        // Same keys as the PHP app: the workspace-storage choice is not carried over
        [THEME_KEY, FONT_FAMILY_KEY, FONT_SIZE_KEY].forEach((key, position) => {
            const localEntry = findNode(db, entryId(localRootId, key));
            const cloudEntry = findNode(db, entryId(cloudRootId, key));

            if (localEntry !== null && cloudEntry === null) {
                changes.push(
                    setChange(
                        entryId(cloudRootId, key),
                        cloudRootId,
                        entryFields(
                            cloudRootId,
                            positionAt(position),
                            localEntry.content,
                        ),
                    ),
                );
            }

            if (localEntry !== null) {
                changes.push(deleteChange(localEntry.id, localRootId));
            }
        });

        changes.push(deleteChange(localRootId, PreferenceNodes.ROOT_ID));
        this.ctx.documents().applyChanges(changes, 'Adopt preferences');
    }
}
