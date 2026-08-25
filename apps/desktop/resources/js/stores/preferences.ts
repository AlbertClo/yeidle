import { ref } from 'vue';
import type { Appearance, Theme } from '@/types';
import { updateAppearance, useAppearance } from '../composables/useAppearance';
import { requestCloudExchange } from '../sync/cloud';
import type { CommittedOp } from '../sync/localOps';
import { DEFAULT_THEME, isTheme } from '../types/theme';

const { appearance, resolvedAppearance } = useAppearance();
const initialAppearance = appearance.value;

export const themePreference = ref<Theme>(
    initialAppearance === 'system'
        ? resolvedAppearance.value
        : initialAppearance,
);
export const preferenceRootId = ref<string | null>(null);

let loaded = false;
let loadRequest: Promise<void> | null = null;

type PreferenceResponse = {
    root_id: string;
    theme: Theme | null;
};

export async function loadPreferences(force = false): Promise<void> {
    if (loadRequest !== null) {
        await loadRequest;

        if (force) {
            return loadPreferences(true);
        }

        return;
    }

    if (loaded && !force) {
        return;
    }

    loadRequest = fetch('/api/preferences', {
        headers: { Accept: 'application/json' },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load preferences.');
            }

            const payload = (await response.json()) as PreferenceResponse;
            preferenceRootId.value = payload.root_id;

            if (isTheme(payload.theme)) {
                themePreference.value = payload.theme;
                updateAppearance(payload.theme);
            } else {
                themePreference.value = DEFAULT_THEME;
                updateAppearance(DEFAULT_THEME);
            }

            loaded = true;
        })
        .finally(() => {
            loadRequest = null;
        });

    return loadRequest;
}

export async function saveThemePreference(theme: Theme): Promise<void> {
    const previousAppearance: Appearance = appearance.value;
    const previousTheme = themePreference.value;

    themePreference.value = theme;
    updateAppearance(theme);

    try {
        const response = await fetch('/api/preferences/theme', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ theme }),
        });

        if (!response.ok) {
            throw new Error('Could not save the theme preference.');
        }

        const payload = (await response.json()) as PreferenceResponse;
        preferenceRootId.value = payload.root_id;
        loaded = true;
        void requestCloudExchange();
    } catch (error) {
        themePreference.value = previousTheme;
        updateAppearance(previousAppearance);

        throw error;
    }
}

export function opsAffectPreferences(ops: CommittedOp[] | null): boolean {
    if (ops === null || preferenceRootId.value === null) {
        return true;
    }

    return ops.some((op) => {
        const payload = op.payload;

        if (typeof payload !== 'object' || payload === null) {
            return false;
        }

        const fields = payload as Record<string, unknown>;

        return (
            fields.id === preferenceRootId.value ||
            fields.page_id === preferenceRootId.value
        );
    });
}
