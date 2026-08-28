export const OPEN_WORKSPACE_SYNC_EVENT = 'yeidle:open-workspace-sync';
export const WORKSPACE_SYNC_ENABLED_EVENT = 'yeidle:workspace-sync-enabled';

export function openWorkspaceSync(): void {
    window.dispatchEvent(new Event(OPEN_WORKSPACE_SYNC_EVENT));
}

export function notifyWorkspaceSyncEnabled(workspaceId: string): void {
    window.dispatchEvent(
        new CustomEvent(WORKSPACE_SYNC_ENABLED_EVENT, {
            detail: { workspaceId },
        }),
    );
}
