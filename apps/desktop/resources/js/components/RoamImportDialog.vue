<script setup lang="ts">
import { FileUp, LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

type Workspace = {
    id: string;
    name: string;
    database: string;
};

type ImportResult = {
    workspace: Workspace;
    report: Record<string, number>;
    warnings: string[];
    has_failures: boolean;
};

const props = defineProps<{
    open: boolean;
    workspaces: Workspace[];
    activeWorkspaceId: string | null;
}>();

const emit = defineEmits<{
    'update:open': [open: boolean];
    'workspace-added': [workspace: Workspace];
    imported: [workspace: Workspace];
}>();

const file = ref<File | null>(null);
const destination = ref('__new__');
const newWorkspaceName = ref('');
const downloadAttachments = ref(true);
const phase = ref<'idle' | 'uploading' | 'importing' | 'complete'>('idle');
const uploadProgress = ref(0);
const error = ref<string | null>(null);
const result = ref<ImportResult | null>(null);

const busy = computed(
    () => phase.value === 'uploading' || phase.value === 'importing',
);
const canImport = computed(
    () =>
        file.value !== null &&
        !busy.value &&
        (destination.value !== '__new__' ||
            newWorkspaceName.value.trim() !== ''),
);

const reportRows = computed(() => {
    if (result.value === null) {
        return [];
    }

    const labels = [
        'Pages',
        'Blocks',
        'Attachments imported',
        'Attachments reused',
        'Attachments failed',
        'Nodes written',
        'Nodes already imported',
    ];

    return labels.map((label) => ({
        label,
        value: result.value?.report[label] ?? 0,
    }));
});

watch(
    () => props.open,
    (open) => {
        if (!open) {
            return;
        }

        file.value = null;
        destination.value = '__new__';
        newWorkspaceName.value = '';
        downloadAttachments.value = true;
        phase.value = 'idle';
        uploadProgress.value = 0;
        error.value = null;
        result.value = null;
    },
);

function updateOpen(open: boolean): void {
    if (!busy.value) {
        emit('update:open', open);
    }
}

function preventClose(event: Event): void {
    if (busy.value) {
        event.preventDefault();
    }
}

function suggestedWorkspaceName(filename: string): string {
    const base = filename
        .replace(/\.json$/i, '')
        .replace(/-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$/u, '')
        .replace(/[-_]+/gu, ' ')
        .trim();

    return base.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function selectFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    file.value = input.files?.[0] ?? null;
    error.value = null;

    if (file.value && newWorkspaceName.value === '') {
        newWorkspaceName.value = suggestedWorkspaceName(file.value.name);
    }
}

async function responsePayload<T>(response: Response): Promise<T> {
    const payload = (await response.json().catch(() => null)) as
        | (T & { message?: string; errors?: Record<string, string[]> })
        | null;

    if (!response.ok || payload === null) {
        const validationMessage = payload?.errors
            ? Object.values(payload.errors).flat()[0]
            : null;

        throw new Error(
            validationMessage ??
                payload?.message ??
                `Import request failed (${response.status}).`,
        );
    }

    return payload;
}

async function cancelUpload(uploadId: string): Promise<void> {
    await fetch(`/api/imports/roam/${uploadId}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    }).catch(() => null);
}

async function importRoam(): Promise<void> {
    const selectedFile = file.value;

    if (!selectedFile || !canImport.value) {
        return;
    }

    let uploadId: string | null = null;

    phase.value = 'uploading';
    uploadProgress.value = 0;
    error.value = null;

    try {
        const initialization = await responsePayload<{
            upload_id: string;
            chunk_size: number;
            total_chunks: number;
        }>(
            await fetch('/api/imports/roam/init', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    filename: selectedFile.name,
                    size: selectedFile.size,
                }),
            }),
        );
        uploadId = initialization.upload_id;

        for (let index = 0; index < initialization.total_chunks; index++) {
            const form = new FormData();
            const chunk = selectedFile.slice(
                index * initialization.chunk_size,
                Math.min(
                    (index + 1) * initialization.chunk_size,
                    selectedFile.size,
                ),
            );
            form.append('upload_id', uploadId);
            form.append('chunk_index', String(index));
            form.append('chunk', chunk, `chunk_${index}`);

            await responsePayload(
                await fetch('/api/imports/roam/chunk', {
                    method: 'POST',
                    headers: { Accept: 'application/json' },
                    body: form,
                }),
            );
            uploadProgress.value = Math.round(
                ((index + 1) / initialization.total_chunks) * 100,
            );
        }

        phase.value = 'importing';
        result.value = await responsePayload<ImportResult>(
            await fetch('/api/imports/roam/finish', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    upload_id: uploadId,
                    workspace_id:
                        destination.value === '__new__'
                            ? null
                            : destination.value,
                    new_workspace_name:
                        destination.value === '__new__'
                            ? newWorkspaceName.value.trim()
                            : null,
                    download_attachments: downloadAttachments.value,
                }),
            }),
        );
        emit('workspace-added', result.value.workspace);
        uploadId = null;
        phase.value = 'complete';
    } catch (reason) {
        if (uploadId !== null) {
            await cancelUpload(uploadId);
        }

        error.value =
            reason instanceof Error
                ? reason.message
                : 'The Roam database could not be imported.';
        phase.value = 'idle';
    }
}

function openImportedWorkspace(): void {
    if (result.value === null) {
        return;
    }

    emit('imported', result.value.workspace);
}
</script>

<template>
    <Dialog :open="open" @update:open="updateOpen">
        <DialogContent
            class="sm:max-w-xl"
            :show-close-button="!busy"
            @escape-key-down="preventClose"
            @interact-outside="preventClose"
        >
            <template v-if="phase !== 'complete'">
                <DialogHeader>
                    <DialogTitle>Import Roam Research database</DialogTitle>
                    <DialogDescription>
                        Import a Roam JSON export into an existing local
                        workspace or create a separate workspace for it.
                    </DialogDescription>
                </DialogHeader>

                <form class="grid gap-5" @submit.prevent="importRoam">
                    <div class="grid gap-2">
                        <Label for="roam-export">Roam JSON export</Label>
                        <Input
                            id="roam-export"
                            type="file"
                            accept="application/json,.json"
                            :disabled="busy"
                            @change="selectFile"
                        />
                        <p v-if="file" class="text-xs text-muted-foreground">
                            {{ file.name }} ·
                            {{ (file.size / 1024 / 1024).toFixed(1) }} MB
                        </p>
                    </div>

                    <div class="grid gap-2">
                        <Label for="roam-destination">Destination</Label>
                        <select
                            id="roam-destination"
                            v-model="destination"
                            class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="busy"
                        >
                            <option value="__new__">
                                Create a new workspace
                            </option>
                            <option
                                v-for="workspace in workspaces"
                                :key="workspace.id"
                                :value="workspace.id"
                            >
                                {{ workspace.name }}
                                {{
                                    workspace.id === activeWorkspaceId
                                        ? '(current)'
                                        : ''
                                }}
                            </option>
                        </select>
                    </div>

                    <div v-if="destination === '__new__'" class="grid gap-2">
                        <Label for="roam-workspace-name">Workspace name</Label>
                        <Input
                            id="roam-workspace-name"
                            v-model="newWorkspaceName"
                            maxlength="100"
                            placeholder="My Roam database"
                            :disabled="busy"
                        />
                    </div>

                    <div
                        v-else
                        class="rounded-md bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200"
                    >
                        Imported pages will be merged into this workspace.
                        Reimporting the same export is safe and will not create
                        duplicates.
                    </div>

                    <div class="flex items-start gap-2">
                        <Checkbox
                            id="roam-download-attachments"
                            v-model="downloadAttachments"
                            :disabled="busy"
                        />
                        <div class="grid gap-0.5">
                            <Label for="roam-download-attachments">
                                Import file uploads
                            </Label>
                            <p class="text-xs text-muted-foreground">
                                Download Roam-hosted images and files into
                                Yeidle’s media storage.
                            </p>
                        </div>
                    </div>

                    <div v-if="busy" class="grid gap-2">
                        <div class="flex items-center gap-2 text-sm">
                            <LoaderCircle class="size-4 animate-spin" />
                            <span v-if="phase === 'uploading'">
                                Uploading export… {{ uploadProgress }}%
                            </span>
                            <span v-else>
                                Importing pages and attachments…
                            </span>
                        </div>
                        <div
                            class="h-1.5 overflow-hidden rounded-full bg-muted"
                        >
                            <div
                                v-if="phase === 'uploading'"
                                class="h-full bg-primary transition-[width]"
                                :style="{ width: `${uploadProgress}%` }"
                            />
                            <div
                                v-else
                                class="import-progress h-full rounded-full bg-primary"
                            />
                        </div>
                        <p class="text-xs text-muted-foreground">
                            Keep this window open. Large databases and file
                            downloads can take several minutes.
                        </p>
                    </div>

                    <div
                        v-if="error"
                        class="flex gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
                        role="alert"
                    >
                        <TriangleAlert class="mt-0.5 size-4 shrink-0" />
                        <span>{{ error }}</span>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            :disabled="busy"
                            @click="updateOpen(false)"
                        >
                            Cancel
                        </Button>
                        <Button type="submit" :disabled="!canImport">
                            <LoaderCircle v-if="busy" class="animate-spin" />
                            <FileUp v-else />
                            {{ busy ? 'Importing…' : 'Import database' }}
                        </Button>
                    </DialogFooter>
                </form>
            </template>

            <template v-else-if="result">
                <DialogHeader>
                    <DialogTitle>Import complete</DialogTitle>
                    <DialogDescription>
                        Roam was imported into {{ result.workspace.name }}.
                    </DialogDescription>
                </DialogHeader>

                <div class="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                    <div
                        v-for="row in reportRows"
                        :key="row.label"
                        class="contents"
                    >
                        <span class="text-muted-foreground">
                            {{ row.label }}
                        </span>
                        <span class="text-right tabular-nums">
                            {{ row.value.toLocaleString() }}
                        </span>
                    </div>
                </div>

                <div
                    v-if="result.has_failures"
                    class="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200"
                >
                    The import completed with unresolved references or file
                    download failures. The original text and links were
                    preserved where possible.
                </div>

                <div
                    v-if="result.warnings.length > 0"
                    class="max-h-32 overflow-y-auto rounded-md border p-3 text-xs text-muted-foreground"
                >
                    <p v-for="(warning, index) in result.warnings" :key="index">
                        {{ warning }}
                    </p>
                </div>

                <DialogFooter>
                    <Button @click="openImportedWorkspace">
                        Open workspace
                    </Button>
                </DialogFooter>
            </template>
        </DialogContent>
    </Dialog>
</template>

<style scoped>
@keyframes import-progress {
    from {
        transform: translateX(-100%);
    }

    to {
        transform: translateX(300%);
    }
}

.import-progress {
    width: 33.333%;
    animation: import-progress 1.25s ease-in-out infinite;
}
</style>
