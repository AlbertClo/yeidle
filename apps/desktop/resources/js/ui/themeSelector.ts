export const OPEN_THEME_SELECTOR_EVENT = 'yeidle:open-theme-selector';

export function openThemeSelector(): void {
    window.dispatchEvent(new Event(OPEN_THEME_SELECTOR_EVENT));
}
