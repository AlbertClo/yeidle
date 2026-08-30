<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import {
    AlertCircle,
    Check,
    ChevronsUpDown,
    Cloud,
    CloudDownload,
    CloudUpload,
    FileUp,
    LoaderCircle,
    LogIn,
    LogOut,
    Pencil,
    Plus,
    Settings2,
    UserRound,
} from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
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
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    flushNavigationHistory,
    reloadNavigationHistory,
} from '@/navigation/historyNavigation';
import {
    cloudAccount,
    enableWorkspaceCloudSync,
    loadCloudAccount,
    signOutCloudAccount,
    syncActiveCloudWorkspace,
} from '@/stores/cloudAccount';
import { loadKeyBindings } from '@/stores/keyBindings';
import { loadPreferences } from '@/stores/preferences';
import {
    loadWorkspaceState,
    workspaceState as state,
} from '@/stores/workspaces';
import { requestCloudExchange } from '@/sync/cloud';
import { refreshRealtimeSync } from '@/sync/realtime';
import type { Workspace, WorkspaceState } from '@/types/workspace';
import { openCloudAccount } from '@/ui/cloudAccount';
import { notifyWorkspaceSyncEnabled } from '@/ui/workspaceSync';

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
const manageDialogOpen = ref(false);
const syncConfirmationOpen = ref(false);
const deleteConfirmationOpen = ref(false);
const showOnDiskConfirmationOpen = ref(false);
const workspaceName = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const editingWorkspaceId = ref<string | null>(null);
const editingWorkspaceName = ref('');
const workspaceActionId = ref<string | null>(null);
const manageError = ref<string | null>(null);
const managedWorkspaceId = ref<string | null>(null);
const syncWorkspaceId = ref<string | null>(null);
const deleteWorkspaceId = ref<string | null>(null);
const showOnDiskWorkspaceId = ref<string | null>(null);

function focusOtherSyncAction(event: KeyboardEvent): void {
    const current = event.currentTarget;

    if (!(current instanceof HTMLButtonElement)) {
        return;
    }

    const actions = current.parentElement?.querySelectorAll<HTMLButtonElement>(
        ':scope > button:not(:disabled)',
    );

    Array.from(actions ?? [])
        .find((action) => action !== current)
        ?.focus();
}

const activeWorkspace = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === state.value?.active_workspace_id,
        ) ?? null,
);

const managedWorkspace = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === managedWorkspaceId.value,
        ) ?? null,
);

const syncWorkspace = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === syncWorkspaceId.value,
        ) ?? null,
);

const workspaceToDelete = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === deleteWorkspaceId.value,
        ) ?? null,
);

const workspaceToShowOnDisk = computed(
    () =>
        state.value?.workspaces.find(
            (workspace) => workspace.id === showOnDiskWorkspaceId.value,
        ) ?? null,
);

function visitPages(): void {
    router.visit('/', {
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
        await flushNavigationHistory();

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

        if (
            workspace.cloud_status !== 'local' &&
            workspace.cloud_status !== 'ready'
        ) {
            if (state.value) {
                const localWorkspace = state.value.workspaces.find(
                    (item) => item.id === workspace.id,
                );

                if (localWorkspace) {
                    localWorkspace.cloud_status = 'syncing';
                }
            }

            await syncActiveCloudWorkspace();
        }

        await Promise.all([loadPreferences(true), loadKeyBindings(true)]).catch(
            () => undefined,
        );
        await reloadNavigationHistory('/pages').catch(() => undefined);
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

async function signOut(): Promise<void> {
    if (loading.value) {
        return;
    }

    loading.value = true;

    try {
        await signOutCloudAccount();
        await Promise.all([loadWorkspaceState(true), refreshRealtimeSync()]);
        toast.success('Signed out of Yeidle Cloud.');
    } catch (reason) {
        toast.error(
            reason instanceof Error
                ? reason.message
                : 'Could not sign out of Yeidle Cloud.',
        );
    } finally {
        loading.value = false;
    }
}

function rememberWorkspace(workspace: Workspace): void {
    if (!state.value?.workspaces.some((item) => item.id === workspace.id)) {
        state.value?.workspaces.push(workspace);
    }
}

function replaceWorkspace(workspace: Workspace): void {
    if (!state.value) {
        return;
    }

    state.value = {
        ...state.value,
        workspaces: state.value.workspaces.map((item) =>
            item.id === workspace.id ? workspace : item,
        ),
    };
}

function canRename(workspace: Workspace): boolean {
    return workspace.cloud_status === 'local' || workspace.cloud_owned === true;
}

function canDelete(workspace: Workspace): boolean {
    return workspace.cloud_status === 'local' || workspace.cloud_owned === true;
}

function openWorkspaceManager(workspace: Workspace): void {
    managedWorkspaceId.value = workspace.id;
    manageError.value = null;
    cancelRename();
    manageDialogOpen.value = true;
}

function beginRename(workspace: Workspace): void {
    editingWorkspaceId.value = workspace.id;
    editingWorkspaceName.value = workspace.name;
    manageError.value = null;

    void nextTick(() => {
        const input = document.getElementById(
            'workspace-rename',
        ) as HTMLInputElement | null;

        input?.focus();
        input?.select();
    });
}

function cancelRename(): void {
    editingWorkspaceId.value = null;
    editingWorkspaceName.value = '';
}

function requestCloudSync(workspace: Workspace): void {
    syncWorkspaceId.value = workspace.id;
    manageError.value = null;
    syncConfirmationOpen.value = true;
}

function requestWorkspaceDeletion(workspace: Workspace): void {
    if (!canDelete(workspace)) {
        return;
    }

    deleteWorkspaceId.value = workspace.id;
    manageError.value = null;
    deleteConfirmationOpen.value = true;
}

function requestShowWorkspaceOnDisk(workspace: Workspace): void {
    showOnDiskWorkspaceId.value = workspace.id;
    manageError.value = null;
    showOnDiskConfirmationOpen.value = true;
}

function workspaceDatabaseFilename(workspace: Workspace): string {
    const segments = workspace.database.split(/[\\/]/);

    return segments[segments.length - 1] || workspace.database;
}

function workspaceMediaDirectoryName(workspace: Workspace): string {
    const databaseFilename = workspaceDatabaseFilename(workspace);

    return databaseFilename === 'nativephp.sqlite'
        ? 'media'
        : databaseFilename.replace(/\.sqlite$/i, '');
}

async function deleteWorkspace(workspace: Workspace): Promise<void> {
    if (workspaceActionId.value || !canDelete(workspace)) {
        return;
    }

    workspaceActionId.value = workspace.id;
    manageError.value = null;
    const wasActive = workspace.id === state.value?.active_workspace_id;

    try {
        const response = await fetch(`/api/workspaces/${workspace.id}`, {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
        });
        const payload = (await response.json().catch(() => null)) as
            | (WorkspaceState & { message?: string })
            | null;

        if (
            !response.ok ||
            !payload?.active_workspace_id ||
            !Array.isArray(payload.workspaces)
        ) {
            throw new Error(
                payload?.message ?? 'Could not delete the workspace.',
            );
        }

        state.value = payload;
        await loadCloudAccount(true).catch(() => undefined);
        deleteConfirmationOpen.value = false;
        manageDialogOpen.value = false;
        deleteWorkspaceId.value = null;
        managedWorkspaceId.value = null;

        if (wasActive) {
            await Promise.all([
                loadPreferences(true),
                loadKeyBindings(true),
            ]).catch(() => undefined);
            loading.value = true;
            visitPages();
        }

        toast.success(`${workspace.name} was deleted.`);
    } catch (reason) {
        manageError.value =
            reason instanceof Error
                ? reason.message
                : 'Could not delete the workspace.';
    } finally {
        workspaceActionId.value = null;
    }
}

async function renameWorkspace(workspace: Workspace): Promise<void> {
    const name = editingWorkspaceName.value.trim();

    if (workspaceActionId.value || !name || name === workspace.name) {
        if (name === workspace.name) {
            cancelRename();
        }

        return;
    }

    workspaceActionId.value = workspace.id;
    manageError.value = null;

    try {
        const response = await fetch(`/api/workspaces/${workspace.id}`, {
            method: 'PATCH',
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
                payload?.message ?? 'Could not rename the workspace.',
            );
        }

        replaceWorkspace(payload.workspace);
        cancelRename();
        await loadCloudAccount(true).catch(() => undefined);
    } catch (reason) {
        manageError.value =
            reason instanceof Error
                ? reason.message
                : 'Could not rename the workspace.';
    } finally {
        workspaceActionId.value = null;
    }
}

async function showWorkspaceOnDisk(
    workspace: Workspace,
    target: 'database' | 'media',
): Promise<void> {
    if (workspaceActionId.value) {
        return;
    }

    workspaceActionId.value = workspace.id;
    manageError.value = null;
    showOnDiskConfirmationOpen.value = false;

    await nextTick();
    manageDialogOpen.value = true;

    try {
        const response = await fetch(
            '/api/workspaces/' + workspace.id + '/show-on-disk',
            {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ target }),
            },
        );
        const payload = (await response.json().catch(() => null)) as {
            message?: string;
        } | null;

        if (!response.ok) {
            throw new Error(
                payload?.message ?? 'Could not show the workspace on disk.',
            );
        }
    } catch (reason) {
        manageError.value =
            reason instanceof Error
                ? reason.message
                : 'Could not show the workspace on disk.';
    } finally {
        workspaceActionId.value = null;
        showOnDiskWorkspaceId.value = null;
    }
}

async function enableCloudSync(workspace: Workspace): Promise<void> {
    if (workspaceActionId.value || !cloudAccount.value?.signed_in) {
        return;
    }

    const returnToManager = managedWorkspaceId.value === workspace.id;

    workspaceActionId.value = workspace.id;
    manageError.value = null;
    syncConfirmationOpen.value = false;

    if (returnToManager) {
        await nextTick();
        manageDialogOpen.value = true;
    }

    try {
        replaceWorkspace({ ...workspace, cloud_status: 'syncing' });

        await enableWorkspaceCloudSync(workspace.id);
        notifyWorkspaceSyncEnabled(workspace.id);

        if (workspace.id === state.value?.active_workspace_id) {
            await Promise.all([
                loadPreferences(true),
                loadKeyBindings(true),
                refreshRealtimeSync(),
            ]);
            await requestCloudExchange();
        }

        syncWorkspaceId.value = null;
    } catch (reason) {
        manageError.value =
            reason instanceof Error
                ? reason.message
                : 'Could not enable cloud sync.';
        await loadWorkspaceState(true).catch(() => undefined);
    } finally {
        workspaceActionId.value = null;

        if (returnToManager) {
            manageDialogOpen.value = true;
        }
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
                    <LoaderCircle
                        v-if="activeWorkspace?.cloud_status === 'syncing'"
                        class="ml-auto size-4 animate-spin"
                        aria-label="Downloading workspace"
                    />
                    <ChevronsUpDown v-else class="ml-auto size-4" />
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
                <div
                    v-for="workspace in state?.workspaces ?? []"
                    :key="workspace.id"
                    class="flex min-w-0 items-center"
                >
                    <DropdownMenuItem
                        class="min-w-0 flex-1"
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
                        <LoaderCircle
                            v-if="workspace.cloud_status === 'syncing'"
                            class="ml-auto size-3.5 animate-spin text-muted-foreground"
                        />
                        <CloudDownload
                            v-else-if="workspace.cloud_status === 'available'"
                            class="ml-auto size-3.5 text-muted-foreground"
                            aria-label="Available from cloud"
                        />
                        <Cloud
                            v-else-if="workspace.cloud_status === 'ready'"
                            class="ml-auto size-3.5"
                            :class="
                                cloudAccount?.signed_in
                                    ? 'text-[var(--link)]'
                                    : 'text-muted-foreground'
                            "
                            aria-label="Cloud synced"
                        />
                        <AlertCircle
                            v-else-if="workspace.cloud_status === 'error'"
                            class="ml-auto size-3.5 text-destructive"
                            aria-label="Cloud sync error"
                        />
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        class="shrink-0 px-2"
                        :aria-label="`Manage ${workspace.name}`"
                        @select="openWorkspaceManager(workspace)"
                    >
                        <Settings2 class="size-4" />
                    </DropdownMenuItem>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem @select="createDialogOpen = true">
                    <Plus class="size-4" />
                    New workspace
                </DropdownMenuItem>
                <DropdownMenuItem @select="importDialogOpen = true">
                    <FileUp class="size-4" />
                    Import
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                    v-if="cloudAccount?.signed_in"
                    @select="openCloudAccount"
                >
                    <UserRound class="size-4" />
                    {{ cloudAccount.user?.name ?? 'Yeidle account' }}
                </DropdownMenuItem>
                <DropdownMenuItem
                    v-if="!cloudAccount?.signed_in"
                    @select="openCloudAccount"
                >
                    <LogIn class="size-4" />
                    Sign in
                </DropdownMenuItem>
                <DropdownMenuItem v-else @select="signOut">
                    <LogOut class="size-4" />
                    Sign out
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

        <Dialog v-model:open="manageDialogOpen">
            <DialogContent class="sm:max-w-2xl">
                <DialogHeader v-if="managedWorkspace">
                    <DialogTitle>{{ managedWorkspace.name }}</DialogTitle>
                    <DialogDescription>
                        <template
                            v-if="managedWorkspace.cloud_status === 'syncing'"
                        >
                            This workspace is being connected to Yeidle Cloud.
                        </template>
                        <template
                            v-else-if="
                                managedWorkspace.cloud_status === 'local'
                            "
                        >
                            Rename this workspace or choose whether to sync it
                            with Yeidle Cloud.
                        </template>
                        <template v-else-if="managedWorkspace.cloud_owned">
                            This workspace is synced with Yeidle Cloud.
                        </template>
                        <template v-else>
                            This workspace is synced with Yeidle Cloud and
                            shared with you.
                        </template>
                    </DialogDescription>
                </DialogHeader>

                <div
                    v-if="managedWorkspace"
                    class="flex min-h-14 items-center gap-3 rounded-md border px-3 py-2"
                >
                    <form
                        v-if="editingWorkspaceId === managedWorkspace.id"
                        class="flex min-w-0 flex-1 items-center gap-2"
                        @submit.prevent="renameWorkspace(managedWorkspace)"
                    >
                        <Input
                            id="workspace-rename"
                            v-model="editingWorkspaceName"
                            maxlength="100"
                            aria-label="Workspace name"
                            :disabled="
                                workspaceActionId === managedWorkspace.id
                            "
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            :disabled="
                                workspaceActionId === managedWorkspace.id
                            "
                            @click="cancelRename"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            size="sm"
                            :disabled="
                                workspaceActionId === managedWorkspace.id ||
                                !editingWorkspaceName.trim()
                            "
                        >
                            Save
                        </Button>
                    </form>

                    <template v-else>
                        <div class="min-w-0 flex-1">
                            <div class="truncate font-medium">
                                {{ managedWorkspace.name }}
                            </div>
                            <div class="text-xs text-muted-foreground">
                                {{
                                    managedWorkspace.cloud_status === 'syncing'
                                        ? 'Syncing with Yeidle Cloud…'
                                        : managedWorkspace.cloud_status ===
                                            'local'
                                          ? 'Only on this device'
                                          : managedWorkspace.cloud_owned
                                            ? 'Synced with Yeidle Cloud'
                                            : 'Shared with you'
                                }}
                            </div>
                        </div>

                        <LoaderCircle
                            v-if="managedWorkspace.cloud_status === 'syncing'"
                            class="size-4 animate-spin text-muted-foreground"
                            aria-label="Syncing workspace"
                        />
                        <Button
                            v-if="canRename(managedWorkspace)"
                            type="button"
                            size="sm"
                            variant="ghost"
                            :disabled="workspaceActionId !== null"
                            @click="beginRename(managedWorkspace)"
                        >
                            <Pencil />
                            Rename
                        </Button>
                        <Button
                            v-if="managedWorkspace.cloud_status === 'local'"
                            type="button"
                            size="sm"
                            variant="outline"
                            :disabled="
                                workspaceActionId !== null ||
                                !cloudAccount?.signed_in
                            "
                            :title="
                                cloudAccount?.signed_in
                                    ? 'Upload this workspace and keep it synced with Yeidle Cloud.'
                                    : 'Sign in to Yeidle Cloud before enabling sync.'
                            "
                            @click="requestCloudSync(managedWorkspace)"
                        >
                            <LoaderCircle
                                v-if="workspaceActionId === managedWorkspace.id"
                                class="animate-spin"
                            />
                            <CloudUpload v-else />
                            Sync
                        </Button>
                    </template>
                </div>

                <p
                    v-if="manageError"
                    class="text-sm text-destructive"
                    role="alert"
                >
                    {{ manageError }}
                </p>
                <p
                    v-else-if="!cloudAccount?.signed_in"
                    class="text-sm text-muted-foreground"
                >
                    Sign in from the cloud button to enable sync for a local
                    workspace.
                </p>

                <DialogFooter
                    v-if="managedWorkspace"
                    class="sm:justify-between"
                >
                    <div class="flex items-center gap-2">
                        <TooltipProvider :delay-duration="0">
                            <Tooltip :disabled="canDelete(managedWorkspace)">
                                <TooltipTrigger as-child>
                                    <span class="inline-flex">
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            class="text-muted-foreground hover:text-foreground"
                                            :disabled="
                                                workspaceActionId !== null ||
                                                !canDelete(managedWorkspace)
                                            "
                                            @click="
                                                requestWorkspaceDeletion(
                                                    managedWorkspace,
                                                )
                                            "
                                        >
                                            Delete workspace
                                        </Button>
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent side="top">
                                    Only the workspace owner can delete a cloud
                                    workspace.
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                        <Button
                            type="button"
                            variant="ghost"
                            class="text-muted-foreground hover:text-foreground"
                            :disabled="workspaceActionId !== null"
                            @click="
                                requestShowWorkspaceOnDisk(managedWorkspace)
                            "
                        >
                            Show on disk
                        </Button>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        @click="manageDialogOpen = false"
                    >
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="showOnDiskConfirmationOpen">
            <DialogContent>
                <DialogHeader v-if="workspaceToShowOnDisk">
                    <DialogTitle>
                        Show {{ workspaceToShowOnDisk.name }} on disk
                    </DialogTitle>
                    <DialogDescription>
                        Use the buttons below to locate this workspace’s
                        database file and media folder. You can copy both to
                        make a manual backup, but editing or replacing them
                        directly is not recommended.
                    </DialogDescription>
                </DialogHeader>

                <div
                    v-if="workspaceToShowOnDisk"
                    class="divide-y rounded-md border bg-muted/50"
                >
                    <div class="px-3 py-2">
                        <div class="text-xs text-muted-foreground">
                            Database file
                        </div>
                        <code class="block truncate text-sm text-foreground">
                            {{
                                workspaceDatabaseFilename(workspaceToShowOnDisk)
                            }}
                        </code>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            class="mt-2"
                            :disabled="workspaceActionId !== null"
                            @click="
                                showWorkspaceOnDisk(
                                    workspaceToShowOnDisk,
                                    'database',
                                )
                            "
                        >
                            Show on disk
                        </Button>
                    </div>
                    <div class="px-3 py-2">
                        <div class="text-xs text-muted-foreground">
                            Media folder
                        </div>
                        <code class="block truncate text-sm text-foreground">
                            {{
                                workspaceMediaDirectoryName(
                                    workspaceToShowOnDisk,
                                )
                            }}
                        </code>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            class="mt-2"
                            :disabled="workspaceActionId !== null"
                            @click="
                                showWorkspaceOnDisk(
                                    workspaceToShowOnDisk,
                                    'media',
                                )
                            "
                        >
                            Show on disk
                        </Button>
                    </div>
                </div>

                <DialogFooter v-if="workspaceToShowOnDisk">
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="workspaceActionId !== null"
                        @click="showOnDiskConfirmationOpen = false"
                    >
                        Close
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="deleteConfirmationOpen">
            <DialogContent>
                <DialogHeader v-if="workspaceToDelete">
                    <DialogTitle>
                        Delete {{ workspaceToDelete.name }}?
                    </DialogTitle>
                    <DialogDescription>
                        <template
                            v-if="workspaceToDelete.cloud_status === 'local'"
                        >
                            This permanently deletes the workspace and its data
                            from this device.
                        </template>
                        <template v-else>
                            This permanently deletes the workspace from Yeidle
                            Cloud and your devices. Anyone it is shared with
                            will lose access.
                        </template>
                        This cannot be undone.
                    </DialogDescription>
                </DialogHeader>

                <p
                    v-if="manageError"
                    class="text-sm text-destructive"
                    role="alert"
                >
                    {{ manageError }}
                </p>

                <DialogFooter v-if="workspaceToDelete">
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="workspaceActionId !== null"
                        @click="deleteConfirmationOpen = false"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        :disabled="workspaceActionId !== null"
                        @click="deleteWorkspace(workspaceToDelete)"
                    >
                        <LoaderCircle
                            v-if="workspaceActionId === workspaceToDelete.id"
                            class="animate-spin"
                        />
                        {{
                            workspaceActionId === workspaceToDelete.id
                                ? 'Deleting…'
                                : 'Delete workspace'
                        }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="syncConfirmationOpen">
            <DialogContent>
                <DialogHeader v-if="syncWorkspace">
                    <DialogTitle>Sync {{ syncWorkspace.name }}?</DialogTitle>
                    <DialogDescription>
                        This workspace will be permanently associated with the
                        signed-in Yeidle Cloud account
                        <span class="font-medium text-foreground">
                            {{ cloudAccount?.user?.email }}</span
                        >. This cannot be changed later.
                    </DialogDescription>
                </DialogHeader>

                <p
                    v-if="manageError"
                    class="text-sm text-destructive"
                    role="alert"
                >
                    {{ manageError }}
                </p>

                <DialogFooter v-if="syncWorkspace">
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="workspaceActionId !== null"
                        @click="syncConfirmationOpen = false"
                        @keydown.left.prevent="focusOtherSyncAction"
                        @keydown.right.prevent="focusOtherSyncAction"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        :disabled="workspaceActionId !== null"
                        @click="enableCloudSync(syncWorkspace)"
                        @keydown.left.prevent="focusOtherSyncAction"
                        @keydown.right.prevent="focusOtherSyncAction"
                    >
                        <LoaderCircle
                            v-if="workspaceActionId === syncWorkspace.id"
                            class="animate-spin"
                        />
                        {{
                            workspaceActionId === syncWorkspace.id
                                ? 'Syncing…'
                                : 'Sync workspace'
                        }}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>

        <Dialog v-model:open="createDialogOpen">
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New workspace</DialogTitle>
                    <DialogDescription>
                        This creates a separate local database. It stays on this
                        device until you choose to sync it with Yeidle Cloud.
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
                            {{ loading ? 'Creating…' : 'Create' }}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    </SidebarMenuItem>
</template>
