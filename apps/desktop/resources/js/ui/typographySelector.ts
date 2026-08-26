export const OPEN_TYPOGRAPHY_SELECTOR_EVENT = 'yeidle:open-typography-selector';

export function openTypographySelector(): void {
    window.dispatchEvent(new Event(OPEN_TYPOGRAPHY_SELECTOR_EVENT));
}
