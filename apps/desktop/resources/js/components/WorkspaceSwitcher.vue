<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { Check, ChevronsUpDown, Plus } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import AppLogo from '@/components/AppLogo.vue';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from '@/components/ui/sidebar';
import { refreshRealtimeSync } from '@/sync/realtime';

type Workspace = {
    id: string;
    name: string;
    database: string;
};

type WorkspaceState = {
    active_workspace_id: string;
    workspaces: Workspace[];
};

const { isMobile, state: sidebarState } = useSidebar();
const state = ref<WorkspaceState | null>(null);
const createDialogOpen = ref(false);
const workspaceName = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

const activeWorkspace = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === state.value?.active_workspace_id,
        ) ?? null,
);

async function loadWorkspaces(): Promise<void> {
    const response = await fetch('/api/workspaces', {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error('Could not load local workspaces.');
    }

    state.value = (await response.json()) as WorkspaceState;
}

async function activate(workspace: Workspace): Promise<void> {
    if (loading.value || workspace.id === state.value?.active_workspace_id) {
        return;
    }

    loading.value = true;
    error.value = null;

    try {
        const response = await fetch(
            `/api/workspaces/${workspace.id}/activate`,
            {
                method: 'POST',
                headers: { Accept: 'application/json' },
            },
        );

        if (!response.ok) {
            const payload = (await response.json().catch(() => null)) as {
                message?: string;
            } | null;

            throw new Error(payload?.message ?? 'Could not switch workspaces.');
        }

        state.value = state.value
            ? { ...state.value, active_workspace_id: workspace.id }
            : state.value;

        router.visit('/pages', {
            replace: true,
            onSuccess: () => {
                void refreshRealtimeSync();
            },
            onFinish: () => {
                loading.value = false;
            },
        });
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not switch workspaces.';
        loading.value = false;
    }
}

async function createWorkspace(): Promise<void> {
    const name = workspaceName.value.trim();

    if (loading.value || !name) {
        return;
    }

    loading.value = true;
    error.value = null;

    try {
        const response = await fetch('/api/workspaces', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name }),
        });
        const payload = (await response.json().catch(() => null)) as {
            workspace?: Workspace;
            message?: string;
        } | null;

        if (!response.ok || !payload?.workspace) {
            throw new Error(
                payload?.message ?? 'Could not create the workspace.',
            );
        }

        state.value?.workspaces.push(payload.workspace);
        workspaceName.value = '';
        createDialogOpen.value = false;
        loading.value = false;
        await activate(payload.workspace);
    } catch (reason) {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not create the workspace.';
        loading.value = false;
    }
}

onMounted(() => {
    loadWorkspaces().catch((reason: unknown) => {
        error.value =
            reason instanceof Error
                ? reason.message
                : 'Could not load local workspaces.';
    });
});
</script>

<template>
    <SidebarMenuItem>
        <DropdownMenu>
            <DropdownMenuTrigger as-child>
                <SidebarMenuButton
                    size="lg"
                    class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                    :disabled="loading"
                >
                    <AppLogo :name="activeWorkspace?.name ?? 'Personal'" />
                    <ChevronsUpDown class="ml-auto size-4" />
                </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                :side="
                    isMobile
                        ? 'bottom'
                        : sidebarState === 'collapsed'
                          ? 'left'
                          : 'bottom'
                "
                align="start"
                :side-offset="4"
            >
                <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
                <DropdownMenuItem
                    v-for="workspace in state?.workspaces ?? []"
                    :key="workspace.id"
                    @select="activate(workspace)"
                >
                    <Check
                        class="size-4"
                        :class="
                            workspace.id === state?.active_workspace_id
                                ? 'opacity-100'
                                : 'opacity-0'
                        "
                    />
                    <span class="truncate">{{ workspace.name }}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem @select="createDialogOpen = true">
                    <Plus class="size-4" />
                    New workspace
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>

        <Dialog v-model:open="createDialogOpen">
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New workspace</DialogTitle>
                    <DialogDescription>
                        This creates a separate local database. Its pages and
                        sync state will not be mixed with the current workspace.
                    </DialogDescription>
                </DialogHeader>
                <form class="grid gap-4" @submit.prevent="createWorkspace">
                    <div class="grid gap-2">
                        <Label for="workspace-name">Name</Label>
                        <Input
                            id="workspace-name"
                            v-model="workspaceName"
                            autofocus
                            maxlength="100"
                            placeholder="Albert Knowledge"
                        />
                    </div>
                    <p v-if="error" class="text-sm text-destructive">
                        {{ error }}
                    </p>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            @click="createDialogOpen = false"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            :disabled="loading || !workspaceName.trim()"
                        >
                            {{ loading ? 'Creating…' : 'Create and switch' }}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    </SidebarMenuItem>
</template>
