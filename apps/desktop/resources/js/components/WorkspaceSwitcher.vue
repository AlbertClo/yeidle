<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import { Check, ChevronsUpDown, FileUp, Plus } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import AppLogo from '@/components/AppLogo.vue';
import RoamImportDialog from '@/components/RoamImportDialog.vue';
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
import { loadPreferences } from '@/stores/preferences';
import {
    loadWorkspaceState,
    workspaceState as state,
} from '@/stores/workspaces';
import { requestCloudExchange } from '@/sync/cloud';
import { refreshRealtimeSync } from '@/sync/realtime';
import type { Workspace } from '@/types/workspace';

const props = withDefaults(
    defineProps<{
        placement?: 'sidebar' | 'header';
    }>(),
    {
        placement: 'sidebar',
    },
);

const { isMobile, state: sidebarState } = useSidebar();
const createDialogOpen = ref(false);
const importDialogOpen = ref(false);
const workspaceName = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

const activeWorkspace = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === state.value?.active_workspace_id,
        ) ?? null,
);

function visitPages(): void {
    router.visit('/pages', {
        replace: true,
        onSuccess: () => {
            void refreshRealtimeSync();
            void requestCloudExchange();
        },
        onFinish: () => {
            loading.value = false;
        },
    });
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

        await loadPreferences(true).catch(() => undefined);
        visitPages();
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

function rememberWorkspace(workspace: Workspace): void {
    if (!state.value?.workspaces.some((item) => item.id === workspace.id)) {
        state.value?.workspaces.push(workspace);
    }
}

function openImportedWorkspace(workspace: Workspace): void {
    rememberWorkspace(workspace);

    importDialogOpen.value = false;

    if (workspace.id === state.value?.active_workspace_id) {
        loading.value = true;
        visitPages();

        return;
    }

    void activate(workspace);
}

onMounted(() => {
    loadWorkspaceState().catch((reason: unknown) => {
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
                    :class="[
                        'data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground',
                        props.placement === 'header' && 'h-full rounded-none',
                    ]"
                    :disabled="loading"
                >
                    <AppLogo :name="activeWorkspace?.name" />
                    <ChevronsUpDown class="ml-auto size-4" />
                </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                :side="
                    isMobile || props.placement === 'header'
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
                <DropdownMenuItem @select="importDialogOpen = true">
                    <FileUp class="size-4" />
                    Import Roam database
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>

        <RoamImportDialog
            v-model:open="importDialogOpen"
            :workspaces="state?.workspaces ?? []"
            :active-workspace-id="state?.active_workspace_id ?? null"
            @workspace-added="rememberWorkspace"
            @imported="openImportedWorkspace"
        />

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
