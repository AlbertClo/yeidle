export const OPEN_THEME_SELECTOR_EVENT = 'yeidle:open-theme-selector';
export const THEME_SELECTED_EVENT = 'yeidle:theme-selected';

export function openThemeSelector(): void {
    window.dispatchEvent(new Event(OPEN_THEME_SELECTOR_EVENT));
}

export function notifyThemeSelected(): void {
    window.dispatchEvent(new Event(THEME_SELECTED_EVENT));
}
