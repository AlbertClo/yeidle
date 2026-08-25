import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadWorkspaceState, workspaceState } from './workspaces';

describe('workspace state', () => {
    beforeEach(() => {
        workspaceState.value = null;
        vi.restoreAllMocks();
    });

    it('keeps loaded workspace state across component mounts', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    active_workspace_id: 'knowledge',
                    workspaces: [
                        {
                            id: 'knowledge',
                            name: 'Albert Knowledge',
                            database: 'knowledge.sqlite',
                        },
                    ],
                }),
                { status: 200 },
            ),
        );

        await loadWorkspaceState();
        await loadWorkspaceState();

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(workspaceState.value?.active_workspace_id).toBe('knowledge');
        expect(workspaceState.value?.workspaces[0]?.name).toBe(
            'Albert Knowledge',
        );
    });
});
