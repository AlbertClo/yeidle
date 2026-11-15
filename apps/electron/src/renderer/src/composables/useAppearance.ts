import type { ComputedRef, Ref } from 'vue';
import { computed, ref } from 'vue';
import type { Appearance, ResolvedAppearance, Theme } from '@/types';
import { DEFAULT_APPEARANCE, isDarkTheme, isTheme } from '../types/theme';

export type { Appearance, ResolvedAppearance };

export type UseAppearanceReturn = {
    appearance: Ref<Appearance>;
    resolvedAppearance: ComputedRef<ResolvedAppearance>;
    updateAppearance: (value: Appearance) => void;
};

export function updateTheme(value: Appearance): void {
    if (typeof window === 'undefined') {
        return;
    }

    const resolvedTheme = value === 'system' ? getSystemTheme() : value;

    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.classList.toggle(
        'dark',
        isDarkTheme(resolvedTheme),
    );
}

const setCookie = (name: string, value: string, days = 365) => {
    if (typeof document === 'undefined') {
        return;
    }

    const maxAge = days * 24 * 60 * 60;

    document.cookie = `${name}=${value};path=/;max-age=${maxAge};SameSite=Lax`;
};

const mediaQuery = () => {
    if (typeof window === 'undefined') {
        return null;
    }

    return window.matchMedia('(prefers-color-scheme: dark)');
};

export function getSystemTheme(): Theme {
    return mediaQuery()?.matches ? 'dark' : 'light';
}

const getStoredAppearance = (): Appearance | null => {
    if (typeof window === 'undefined') {
        return null;
    }

    const stored = localStorage.getItem('appearance');

    return stored === 'system' || isTheme(stored) ? stored : null;
};

const prefersDark = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    return window.matchMedia('(prefers-color-scheme: dark)').matches;
};

const handleSystemThemeChange = () => {
    const currentAppearance = getStoredAppearance();

    updateTheme(currentAppearance || DEFAULT_APPEARANCE);
};

export function initializeTheme(): void {
    if (typeof window === 'undefined') {
        return;
    }

    // Initialize theme from the saved preference or the workspace default.
    const savedAppearance = getStoredAppearance();
    updateTheme(savedAppearance || DEFAULT_APPEARANCE);

    // Set up system theme change listener...
    mediaQuery()?.addEventListener('change', handleSystemThemeChange);
}

const appearance = ref<Appearance>(getStoredAppearance() ?? DEFAULT_APPEARANCE);
const resolvedAppearance = computed<ResolvedAppearance>(() => {
    if (appearance.value === 'system') {
        return prefersDark() ? 'dark' : 'light';
    }

    return isDarkTheme(appearance.value) ? 'dark' : 'light';
});

export function updateAppearance(value: Appearance): void {
    appearance.value = value;

    if (typeof window !== 'undefined') {
        localStorage.setItem('appearance', value);
    }

    setCookie('appearance', value);
    updateTheme(value);
}

export function useAppearance(): UseAppearanceReturn {
    return {
        appearance,
        resolvedAppearance,
        updateAppearance,
    };
}
