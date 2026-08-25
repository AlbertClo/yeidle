import { ref } from 'vue';
import type { WorkspaceState } from '@/types/workspace';

export const workspaceState = ref<WorkspaceState | null>(null);

let stateRequest: Promise<void> | null = null;

export function loadWorkspaceState(): Promise<void> {
    if (workspaceState.value !== null) {
        return Promise.resolve();
    }

    if (stateRequest !== null) {
        return stateRequest;
    }

    stateRequest = fetch('/api/workspaces', {
        headers: { Accept: 'application/json' },
    })
        .then((response) => {
            if (!response.ok) {
                throw new Error('Could not load local workspaces.');
            }

            return response.json() as Promise<WorkspaceState>;
        })
        .then((state) => {
            workspaceState.value = state;
        })
        .finally(() => {
            stateRequest = null;
        });

    return stateRequest;
}
