<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { EllipsisVertical, Trash2 } from 'lucide-vue-next';
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { toast } from 'vue-sonner';
import PageEditor from '@/components/PageEditor.vue';
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
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import AppLayout from '@/layouts/AppLayout.vue';
import { getCachedPage, setCachedPage } from '@/stores/pageCache';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';

const props = defineProps<{
    page: Node;
    backlinks: { id: string; page_id: string; page_title: string }[];
}>();

const isEditingTitle = ref(false);
const cached = getCachedPage(props.page.id);
const titleContent = ref(cached?.title ?? props.page.content);
const pageNodes = ref<Node[]>(cached?.children ?? props.page.children ?? []);
const pageBacklinks = ref(props.backlinks);
const editorKey = ref(0);

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
    { title: 'Pages', href: '/pages' },
    {
        title: titleContent.value || '[untitled]',
        href: `/pages/${props.page.id}`,
    },
]);
const titleRef = ref<HTMLInputElement>();
const pageEditorRef = ref<InstanceType<typeof PageEditor>>();

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let hasPendingSync = false;
let pendingNodes: Node[] = [];
let syncing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;

function startEditingTitle(cursorPos?: number) {
    isEditingTitle.value = true;
    setTimeout(() => {
        if (titleRef.value) {
            titleRef.value.focus();

            if (cursorPos !== undefined) {
                titleRef.value.setSelectionRange(cursorPos, cursorPos);
            }
        }
    }, 0);
}

function finishEditingTitle() {
    isEditingTitle.value = false;

    if (titleContent.value !== props.page.content) {
        syncUpdate(props.page.id, { content: titleContent.value });
    }
}

function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        finishEditingTitle();
        pageEditorRef.value?.focusStart();
    } else if (e.key === 'ArrowUp') {
        window.scrollTo({ top: 0 });
    }
}

// --- Sync layer ---

function syncUpdate(id: string, data: Record<string, unknown>) {
    fetch(`/api/nodes/${id}`, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(data),
    });
}

let titleSyncTimer: ReturnType<typeof setTimeout> | null = null;
const titleError = ref(false);

function syncTitleDebounced() {
    if (titleSyncTimer) {
        clearTimeout(titleSyncTimer);
    }

    titleSyncTimer = setTimeout(() => {
        fetch(`/api/nodes/${props.page.id}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({ content: titleContent.value }),
        }).then((res) => {
            if (res.status === 409) {
                titleError.value = true;
                res.json().then((data) => {
                    toast.error(data.message);
                });
            } else {
                titleError.value = false;
                const children =
                    getCachedPage(props.page.id)?.children ?? pageNodes.value;
                setCachedPage(props.page.id, titleContent.value, children);
            }
        });
        titleSyncTimer = null;
    }, 300);
}

interface NodeSnapshot {
    parent_id: string | null;
    position: string;
    content: string;
    is_checked: boolean | null;
    tiptap_content: string;
}

const lastNodeMap = new Map<string, NodeSnapshot>();

function snapshotNode(n: Node): NodeSnapshot {
    return {
        parent_id: n.parent_id,
        position: n.position,
        content: n.content,
        is_checked: n.is_checked ?? null,
        tiptap_content: n.tiptap_content
            ? JSON.stringify(n.tiptap_content)
            : '',
    };
}

function initNodeMap(nodes: Node[]) {
    for (const n of nodes) {
        lastNodeMap.set(n.id, snapshotNode(n));

        if (n.children) {
            initNodeMap(n.children);
        }
    }
}
initNodeMap(pageNodes.value);

function flattenNodes(nodes: Node[]): Node[] {
    const result: Node[] = [];

    for (const n of nodes) {
        result.push(n);

        if (n.children) {
            result.push(...flattenNodes(n.children));
        }
    }

    return result;
}

const JSON_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
};

async function request(
    url: string,
    method: string,
    body?: Record<string, unknown>,
): Promise<Response | null> {
    const payload = body ? JSON.stringify(body) : undefined;

    try {
        return await fetch(url, {
            method,
            headers: JSON_HEADERS,
            // keepalive lets in-flight requests survive app teardown, but
            // rejects bodies over ~64KB — skip it for oversized nodes
            keepalive: !payload || payload.length < 60000,
            body: payload,
        });
    } catch {
        return null;
    }
}

function nodePayload(node: Node): Record<string, unknown> {
    return {
        id: node.id,
        parent_id: node.parent_id,
        position: node.position,
        content: node.content,
        tiptap_content: node.tiptap_content,
        is_checked: node.is_checked,
    };
}

// Sends the diff between lastNodeMap and the given tree as a single
// transactional batch: upserts in pre-order (parents before children),
// deletes last. The server applies all-or-nothing, so snapshots are only
// committed when the whole batch succeeds and a failed batch is retried
// intact by the next run.
async function doSync(nodes: Node[]): Promise<boolean> {
    const currentNodes = flattenNodes(nodes);
    const currentIds = new Set(currentNodes.map((n) => n.id));
    const upserts: Record<string, unknown>[] = [];
    const snapshots = new Map<string, NodeSnapshot>();
    let hasLinkChanges = false;

    for (const node of currentNodes) {
        const prev = lastNodeMap.get(node.id);
        const snap = snapshotNode(node);

        if (prev) {
            const changed =
                snap.parent_id !== prev.parent_id ||
                snap.position !== prev.position ||
                snap.content !== prev.content ||
                snap.is_checked !== prev.is_checked ||
                snap.tiptap_content !== prev.tiptap_content;

            if (!changed) {
                continue;
            }

            if (snap.tiptap_content !== prev.tiptap_content) {
                hasLinkChanges = true;
            }
        } else {
            hasLinkChanges = true;
        }

        upserts.push(nodePayload(node));
        snapshots.set(node.id, snap);
    }

    // Deletes: the server cascades, so only send the top-most node of each
    // deleted subtree (a deleted node whose old parent survives is its own
    // top)
    const deletedIds = [...lastNodeMap.keys()].filter(
        (id) => !currentIds.has(id),
    );
    const deletedSet = new Set(deletedIds);
    const deletes = deletedIds.filter((id) => {
        const parent = lastNodeMap.get(id)?.parent_id;

        return !parent || !deletedSet.has(parent);
    });

    if (upserts.length === 0 && deletedIds.length === 0) {
        return true;
    }

    const res = await request('/api/nodes/batch', 'POST', {
        upserts,
        deletes,
    });

    if (!res?.ok) {
        return false;
    }

    for (const [id, snap] of snapshots) {
        lastNodeMap.set(id, snap);
    }

    for (const id of deletedIds) {
        lastNodeMap.delete(id);
    }

    if (hasLinkChanges) {
        refreshBacklinks();
    }

    return true;
}

function scheduleRetry() {
    if (retryTimer) {
        return;
    }

    retryTimer = setTimeout(() => {
        retryTimer = null;
        retryDelay = Math.min(retryDelay * 2, 30000);
        runSync();
    }, retryDelay);
}

// Single sync runner: at most one doSync in flight, re-runs while edits
// arrived mid-flight, retries with backoff when requests fail
async function runSync() {
    if (syncing) {
        return;
    }

    syncing = true;

    try {
        while (hasPendingSync) {
            hasPendingSync = false;
            const ok = await doSync(pendingNodes);

            if (!ok) {
                hasPendingSync = true;
                scheduleRetry();

                return;
            }

            retryDelay = 1000;
        }
    } finally {
        syncing = false;
    }
}

function refreshBacklinks() {
    fetch(`/api/pages/${props.page.id}/backlinks`, {
        headers: { Accept: 'application/json' },
    })
        .then((res) => res.json())
        .then((data) => {
            pageBacklinks.value = data;
        });
}

function syncDebounced(nodes: Node[]) {
    pendingNodes = nodes;
    hasPendingSync = true;

    if (syncTimer) {
        clearTimeout(syncTimer);
    }

    syncTimer = setTimeout(() => {
        syncTimer = null;
        runSync();
    }, 300);
}

function flushSync() {
    if (titleSyncTimer) {
        clearTimeout(titleSyncTimer);
        titleSyncTimer = null;
        syncUpdate(props.page.id, { content: titleContent.value });
    }

    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }

    runSync();
}

function handleNodesUpdate(nodes: Node[]) {
    setCachedPage(props.page.id, titleContent.value, nodes);
    syncDebounced(nodes);
}

function focusFirstBacklink() {
    nextTick(() => {
        const firstLink = document.querySelector(
            '.backlink-item',
        ) as HTMLElement;
        firstLink?.focus();
    });
}

function focusNextBacklink(e: Event) {
    const current = e.target as HTMLElement;
    const next = current.nextElementSibling as HTMLElement;

    if (next?.classList.contains('backlink-item')) {
        next.focus();
    }
}

function focusPrevBacklink(e: Event) {
    const current = e.target as HTMLElement;
    const prev = current.previousElementSibling as HTMLElement;

    if (prev?.classList.contains('backlink-item')) {
        prev.focus();
    } else {
        // First backlink — focus back to editor's last block
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    }
}

function handleBeforeUnload() {
    flushSync();
}

const showDeleteConfirm = ref(false);

function deletePage() {
    fetch(`/api/nodes/${props.page.id}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    }).then(() => {
        showDeleteConfirm.value = false;
        toast.success(`Deleted "${titleContent.value || '[untitled]'}"`);
        router.visit('/pages');
    });
}

function handleGlobalKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !isEditingTitle.value) {
        const target = e.target as HTMLElement;

        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            return;
        }

        // Don't intercept if the editor already has focus
        if (target.closest('.ProseMirror')) {
            return;
        }

        e.preventDefault();
        const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
        editorEl?.focus();
    }
}

onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('keydown', handleGlobalKeydown);
    refreshBacklinks();
});

onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    document.removeEventListener('keydown', handleGlobalKeydown);
    flushSync();
});
</script>

<template>
    <Head :title="page.content || '[untitled]'" />

    <AppLayout :breadcrumbs="breadcrumbs" :current-page-id="page.id">
        <div class="relative">
            <div class="absolute top-4 right-4">
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="icon" class="shrink-0">
                            <EllipsisVertical class="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem
                            class="text-destructive"
                            @click="showDeleteConfirm = true"
                        >
                            <Trash2 class="mr-2 h-4 w-4" />
                            Delete page
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <div class="mx-auto w-full max-w-2xl p-6">
                <div class="mb-6">
                    <input
                        v-if="isEditingTitle"
                        ref="titleRef"
                        v-model="titleContent"
                        class="w-full border-none bg-transparent text-3xl font-bold outline-none"
                        :class="{ 'text-red-500': titleError }"
                        @blur="finishEditingTitle"
                        @input="syncTitleDebounced"
                        @keydown="handleTitleKeydown"
                    />
                    <h1
                        v-else
                        class="cursor-text text-3xl font-bold"
                        :class="{ 'text-red-500': titleError }"
                        @click="startEditingTitle"
                    >
                        {{ titleContent || '[untitled]' }}
                    </h1>
                </div>

                <div class="mb-4">
                    <PageEditor
                        ref="pageEditorRef"
                        :key="editorKey"
                        :nodes="pageNodes"
                        :page-id="page.id"
                        @update="handleNodesUpdate"
                        @focus-title="startEditingTitle()"
                        @focus-backlinks="focusFirstBacklink"
                    />
                </div>

                <div
                    v-if="pageBacklinks.length > 0"
                    class="mt-8 border-t border-border pt-6"
                >
                    <h2
                        class="mb-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase"
                    >
                        Backlinks
                    </h2>
                    <div class="flex flex-col gap-2">
                        <Link
                            v-for="link in pageBacklinks"
                            :key="link.id"
                            :href="`/pages/${link.page_id}`"
                            class="backlink-item rounded-lg px-3 py-2 text-sm outline-none hover:bg-accent focus:bg-accent"
                            @keydown.enter.prevent="
                                router.visit(`/pages/${link.page_id}`)
                            "
                            @keydown.space.prevent="
                                router.visit(`/pages/${link.page_id}`)
                            "
                            @keydown.q.ctrl.prevent="
                                router.visit(`/pages/${link.page_id}`)
                            "
                            @keydown.q.meta.prevent="
                                router.visit(`/pages/${link.page_id}`)
                            "
                            @keydown.down.prevent="focusNextBacklink($event)"
                            @keydown.up.prevent="focusPrevBacklink($event)"
                        >
                            <span class="opacity-40">[[</span
                            ><span
                                class="font-medium underline underline-offset-2"
                                style="color: var(--link)"
                                >{{ link.page_title }}</span
                            ><span class="opacity-40">]]</span>
                        </Link>
                    </div>
                </div>
            </div>
        </div>
    </AppLayout>

    <Dialog v-model:open="showDeleteConfirm">
        <DialogContent>
            <DialogHeader>
                <DialogTitle>Delete page</DialogTitle>
                <DialogDescription>
                    Are you sure you want to delete "{{
                        titleContent || '[untitled]'
                    }}"? This cannot be undone.
                </DialogDescription>
            </DialogHeader>
            <DialogFooter>
                <Button variant="outline" @click="showDeleteConfirm = false"
                    >Cancel</Button
                >
                <Button variant="destructive" @click="deletePage"
                    >Delete</Button
                >
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
