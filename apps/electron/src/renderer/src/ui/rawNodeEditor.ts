export const OPEN_RAW_NODE_EDITOR_EVENT = 'yeidle:open-raw-node-editor';

export function openRawNodeEditor(): void {
    if (typeof window === 'undefined') {
        return;
    }

    window.dispatchEvent(new Event(OPEN_RAW_NODE_EDITOR_EVENT));
}
