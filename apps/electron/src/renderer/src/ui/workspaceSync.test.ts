import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    notifyWorkspaceSyncEnabled,
    OPEN_WORKSPACE_SYNC_EVENT,
    openWorkspaceSync,
    WORKSPACE_SYNC_ENABLED_EVENT,
} from './workspaceSync';

describe('workspace sync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('notifies the mounted sync status to open', () => {
        const windowTarget = new EventTarget();
        let opened = false;

        windowTarget.addEventListener(OPEN_WORKSPACE_SYNC_EVENT, () => {
            opened = true;
        });
        vi.stubGlobal('window', windowTarget);

        openWorkspaceSync();

        expect(opened).toBe(true);
    });

    it('identifies the workspace whose sync was enabled', () => {
        const windowTarget = new EventTarget();
        let workspaceId: string | undefined;

        windowTarget.addEventListener(WORKSPACE_SYNC_ENABLED_EVENT, (event) => {
            workspaceId = (event as CustomEvent<{ workspaceId: string }>).detail
                .workspaceId;
        });
        vi.stubGlobal('window', windowTarget);

        notifyWorkspaceSyncEnabled('workspace-a');

        expect(workspaceId).toBe('workspace-a');
    });
});
