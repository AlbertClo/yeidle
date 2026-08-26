export const OPEN_KEY_BINDINGS_EVENT = 'yeidle:open-key-bindings';

export function openKeyBindings(): void {
    window.dispatchEvent(new CustomEvent(OPEN_KEY_BINDINGS_EVENT));
}
