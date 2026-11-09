export const LOCAL_NODES_CHANGED_EVENT = 'yeidle:local-nodes-changed';

export type LocalNodesChangedEvent = CustomEvent<{ ids: string[] }>;

export function notifyLocalNodesChanged(ids: string[]): void {
    if (ids.length === 0) {
        return;
    }

    window.dispatchEvent(
        new CustomEvent(LOCAL_NODES_CHANGED_EVENT, {
            detail: { ids: [...new Set(ids)] },
        }),
    );
}
