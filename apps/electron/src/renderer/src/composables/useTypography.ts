import { ref } from 'vue';
import {
    DEFAULT_FONT_FAMILY,
    DEFAULT_FONT_SIZE,
    fontFamilyValue,
    isFontFamily,
    isFontSize,
} from '../types/typography';
import type { FontFamily } from '../types/typography';

const FONT_FAMILY_STORAGE_KEY = 'font-family';
const FONT_SIZE_STORAGE_KEY = 'font-size';

function storedFontFamily(): FontFamily {
    if (typeof window === 'undefined') {
        return DEFAULT_FONT_FAMILY;
    }

    const value = localStorage.getItem(FONT_FAMILY_STORAGE_KEY);

    return isFontFamily(value) ? value : DEFAULT_FONT_FAMILY;
}

function storedFontSize(): number {
    if (typeof window === 'undefined') {
        return DEFAULT_FONT_SIZE;
    }

    const value = Number(localStorage.getItem(FONT_SIZE_STORAGE_KEY));

    return isFontSize(value) ? value : DEFAULT_FONT_SIZE;
}

export const activeFontFamily = ref<FontFamily>(storedFontFamily());
export const activeFontSize = ref(storedFontSize());

export function applyTypography(
    fontFamily: FontFamily,
    fontSize: number,
): void {
    if (typeof document === 'undefined') {
        return;
    }

    document.documentElement.style.setProperty(
        '--app-font-family',
        fontFamilyValue(fontFamily),
    );
    document.documentElement.style.setProperty(
        '--app-font-size',
        `${fontSize}px`,
    );
    document.documentElement.style.setProperty(
        'font-variant-ligatures',
        fontFamily === 'jetbrains-mono' ? 'none' : 'normal',
    );
}

export function updateTypography(
    fontFamily: FontFamily,
    fontSize: number,
): void {
    activeFontFamily.value = fontFamily;
    activeFontSize.value = fontSize;

    if (typeof window !== 'undefined') {
        localStorage.setItem(FONT_FAMILY_STORAGE_KEY, fontFamily);
        localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(fontSize));
    }

    applyTypography(fontFamily, fontSize);
}

export function initializeTypography(): void {
    applyTypography(activeFontFamily.value, activeFontSize.value);
}
