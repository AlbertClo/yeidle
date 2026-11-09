const OPEN_MODAL_SELECTOR = '[data-slot="dialog-content"][data-state="open"]';

export function hasOpenModal(): boolean {
    return (
        typeof document !== 'undefined' &&
        document.querySelector(OPEN_MODAL_SELECTOR) !== null
    );
}
