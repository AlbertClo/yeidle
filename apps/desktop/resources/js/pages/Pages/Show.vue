<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { EllipsisVertical, Pin, Trash2 } from 'lucide-vue-next';
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
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import AppLayout from '@/layouts/AppLayout.vue';
import { bindingLabel } from '@/stores/keyBindings';
import {
    getCachedPage,
    invalidateCachedPage,
    markCachedPageActive,
    markCachedPageInactive,
    setCachedPage,
} from '@/stores/pageCache';
import {
    isNodePinned,
    rememberPinState,
    setNodePinned,
    updatePinnedItemTitle,
} from '@/stores/pins';
import { createMaxWaitScheduler } from '@/sync/maxWaitScheduler';
import { notifyLocalNodesChanged } from '@/sync/nodeChanges';
import {
    getClientId,
    mintNodeDelete,
    mintNodeSet,
    observeHlc,
    pullOps,
    pushOps,
} from '@/sync/ops';
import type { Op } from '@/sync/ops';
import { LOCAL_OPS_AVAILABLE_EVENT } from '@/sync/realtimeOps';
import { applyOpsToTree, findInTree } from '@/sync/tree';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';

const props = defineProps<{
    page: Node;
    pinned: boolean;
    backlinks: { id: string; page_id: string; page_title: string }[];
    syncCursor?: number;
}>();

markCachedPageActive(props.page.id);
rememberPinState({ ...props.page, children: undefined }, props.pinned);

const isEditingTitle = ref(false);
const cached = getCachedPage(props.page.id);
const titleContent = ref(cached?.title ?? props.page.content);
const pageNodes = ref<Node[]>(cached?.children ?? props.page.children ?? []);
const pageBacklinks = ref(props.backlinks);
const editorKey = ref(0);
const pagePinned = computed(() => isNodePinned(props.page.id));

const breadcrumbs = computed<BreadcrumbItem[]>(() => [
    { title: 'All Pages', href: '/pages' },
    {
        title: titleContent.value || '[untitled]',
        href: `/pages/${props.page.id}`,
    },
]);
const titleRef = ref<HTMLInputElement>();
const pageEditorRef = ref<InstanceType<typeof PageEditor>>();

let hasPendingSync = false;
let pendingNodes: Node[] = [];
let syncing = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
const syncScheduler = createMaxWaitScheduler(() => void runSync(), 300, 1000);

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
    titleSyncScheduler.cancel();
    void saveTitle();
}

function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        finishEditingTitle();
        pageEditorRef.value?.focusStart();
    } else if (e.key === 'ArrowUp') {
        document
            .querySelector<HTMLElement>('[data-main-scroll]')
            ?.scrollTo({ top: 0 });
    }
}

// --- Sync layer ---

let lastSavedTitle = props.page.content;
const titleError = ref(false);
const titleSyncScheduler = createMaxWaitScheduler(
    () => void saveTitle(),
    300,
    1000,
);

// Advisory only (sync design: duplicate titles are a soft constraint —
// the log always merges, so the client warns instead of the server
// rejecting)
async function titleIsDuplicate(title: string): Promise<boolean> {
    try {
        const params = new URLSearchParams({
            title,
            except: props.page.id,
        });
        const res = await fetch(`/api/pages/title-exists?${params}`, {
            headers: { Accept: 'application/json' },
        });

        if (!res.ok) {
            return false;
        }

        return (await res.json()).exists === true;
    } catch {
        return false;
    }
}

async function saveTitle() {
    const title = titleContent.value;

    if (title === lastSavedTitle) {
        return;
    }

    if (title !== '' && (await titleIsDuplicate(title))) {
        titleError.value = true;
        toast.error('A page with this name already exists.');

        return;
    }

    titleError.value = false;
    lastSavedTitle = title;
    outbox.push(mintNodeSet(props.page.id, props.page.id, { content: title }));
    runSync();

    const children = getCachedPage(props.page.id)?.children ?? pageNodes.value;
    setCachedPage(props.page.id, title, children);
    updatePinnedItemTitle(props.page.id, title);
}

function syncTitleDebounced() {
    titleSyncScheduler.schedule();
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

// Ops minted but not yet accepted by the local server. Re-pushing after a
// failure is safe: the server is idempotent by op_id.
const outbox: Op[] = [];

// Diffs the editor tree against lastNodeMap, mints field-level ops for the
// changes (sync design §5: only the fields that changed, so concurrent
// edits to different fields of one node merge), and pushes the outbox.
// Snapshots commit at mint time — the outbox owns delivery from there.
async function doSync(nodes: Node[]): Promise<boolean> {
    const currentNodes = flattenNodes(nodes);
    const currentIds = new Set(currentNodes.map((n) => n.id));
    let hasLinkChanges = false;

    for (const node of currentNodes) {
        const prev = lastNodeMap.get(node.id);
        const snap = snapshotNode(node);
        const fields: Record<string, unknown> = {};

        if (prev) {
            if (snap.parent_id !== prev.parent_id) {
                fields.parent_id = node.parent_id;
            }

            if (snap.position !== prev.position) {
                fields.position = node.position;
            }

            if (snap.content !== prev.content) {
                fields.content = node.content;
            }

            if (snap.is_checked !== prev.is_checked) {
                fields.is_checked = node.is_checked;
            }

            if (snap.tiptap_content !== prev.tiptap_content) {
                fields.tiptap_content = node.tiptap_content;
                hasLinkChanges = true;
            }

            if (Object.keys(fields).length === 0) {
                continue;
            }
        } else {
            fields.parent_id = node.parent_id;
            fields.position = node.position;
            fields.content = node.content;
            fields.tiptap_content = node.tiptap_content;
            fields.is_checked = node.is_checked;
            hasLinkChanges = true;
        }

        // The content and position columns are NOT NULL; the server coerces
        // defensively, but a null here means an editor bug worth surfacing
        if ('content' in fields && typeof fields.content !== 'string') {
            console.warn('sync: minting non-string content', node);
            fields.content = fields.content ?? '';
        }

        if ('position' in fields && typeof fields.position !== 'string') {
            console.warn('sync: minting non-string position', node);
            fields.position = fields.position ?? 'a0';
        }

        outbox.push(mintNodeSet(node.id, props.page.id, fields));
        lastNodeMap.set(node.id, snap);
    }

    // Deletion marks only the top-most node of each deleted subtree; the
    // projection derives descendant visibility from the parent chain
    const deletedIds = [...lastNodeMap.keys()].filter(
        (id) => !currentIds.has(id),
    );
    const deletedSet = new Set(deletedIds);

    for (const id of deletedIds) {
        const parent = lastNodeMap.get(id)?.parent_id;

        if (!parent || !deletedSet.has(parent)) {
            outbox.push(mintNodeDelete(id, props.page.id));
        }

        lastNodeMap.delete(id);
    }

    const ok = await flushOutbox();

    if (ok && hasLinkChanges) {
        refreshBacklinks();
    }

    return ok;
}

// Push everything queued; ops stay queued on failure and re-pushing is
// safe (server dedupes by op_id)
async function flushOutbox(): Promise<boolean> {
    const pushed = outbox.length;

    if (pushed === 0) {
        return true;
    }

    const pushedOps = outbox.slice(0, pushed);
    const ok = await pushOps(pushedOps);

    if (!ok) {
        return false;
    }

    outbox.splice(0, pushed);
    notifyLocalNodesChanged(
        pushedOps
            .map((op) => op.payload.id)
            .filter((id): id is string => typeof id === 'string'),
    );

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

// Single sync runner: at most one flush in flight, re-runs while edits
// arrived mid-flight, retries with backoff when requests fail. Drains both
// the editor diff (hasPendingSync) and directly-queued ops (title save,
// page delete) — ops mint once, so a failed push just leaves them queued.
async function runSync() {
    if (syncing) {
        return;
    }

    syncing = true;

    try {
        while (hasPendingSync || outbox.length > 0) {
            let ok: boolean;

            if (hasPendingSync) {
                hasPendingSync = false;
                ok = await doSync(pendingNodes);
            } else {
                ok = await flushOutbox();
            }

            if (!ok) {
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
    syncScheduler.schedule();
}

function flushSync() {
    titleSyncScheduler.flush();
    syncScheduler.cancel();
    void runSync();
}

function handleNodesUpdate(nodes: Node[]) {
    setCachedPage(props.page.id, titleContent.value, nodes);
    syncDebounced(nodes);
}

function handleLocalOpsAvailable() {
    void pollRemoteOps();
}

// --- Remote ops: pull loop + live editor merge (sync design §7) ---

let pullCursor = props.syncCursor ?? 0;
let pullTimer: ReturnType<typeof setInterval> | null = null;
let pulling = false;
const editorAutoFocus = ref(true);
// Content updates that couldn't apply because the cursor was inside the
// target node; retried each tick until the node is free
const pendingContentIds = new Set<string>();

function retryPendingContent() {
    for (const id of [...pendingContentIds]) {
        const node = findInTree(pageNodes.value, id);

        if (!node || pageEditorRef.value?.applyRemoteContent(node)) {
            pendingContentIds.delete(id);
        }
    }
}

async function pollRemoteOps() {
    // Only merge remote state while the local pipeline is empty — the pull
    // rebuilds lastNodeMap wholesale, which is only valid when nothing
    // local is pending or in flight
    if (pulling || syncing || hasPendingSync || outbox.length > 0) {
        return;
    }

    pulling = true;

    try {
        retryPendingContent();

        const result = await pullOps(pullCursor);

        if (!result) {
            return;
        }

        const remote = result.ops.filter(
            (op) => op.client_id !== getClientId(),
        );

        for (const op of remote) {
            observeHlc(op.hlc);

            const pageId = op.payload.page_id as string | undefined;

            if (pageId && pageId !== props.page.id) {
                invalidateCachedPage(pageId);
            }
        }

        // Ops targeting the page node itself: remote title changes update
        // the header directly; the tree merge below only handles children
        for (const op of remote) {
            if (
                op.type === 'node.set' &&
                op.payload.id === props.page.id &&
                !isEditingTitle.value
            ) {
                const fields = op.payload.fields as
                    | Record<string, unknown>
                    | undefined;

                if (fields && 'content' in fields) {
                    titleContent.value = (fields.content as string) ?? '';
                    lastSavedTitle = titleContent.value;
                }
            }
        }

        const currentPage = remote.filter(
            (op) =>
                op.payload.page_id === props.page.id &&
                op.payload.id !== props.page.id,
        );

        if (currentPage.length === 0) {
            pullCursor = result.latest_seq;

            return;
        }

        // Patch a copy of the latest emitted tree (the cache tracks every
        // editor update; pageNodes only tracks mounts) so a deferral
        // leaves no half-applied state behind
        const base = getCachedPage(props.page.id)?.children ?? pageNodes.value;
        const patched = JSON.parse(JSON.stringify(base)) as Node[];
        const { change, contentChanged } = applyOpsToTree(
            patched,
            props.page.id,
            currentPage,
        );

        // A structural change remounts the editor — never yank it out from
        // under an active cursor; retry next tick (typically after blur or
        // typing pause, once the local flush guard clears)
        if (
            change === 'structural' &&
            (isEditingTitle.value ||
                pageEditorRef.value?.selectionBlockId() != null)
        ) {
            return;
        }

        if (change !== 'none') {
            pageNodes.value = patched;
            lastNodeMap.clear();
            initNodeMap(patched);
            setCachedPage(props.page.id, titleContent.value, patched);

            if (change === 'structural') {
                editorAutoFocus.value = false;
                editorKey.value++;
            } else {
                for (const id of contentChanged) {
                    const node = findInTree(patched, id);

                    if (
                        node &&
                        !pageEditorRef.value?.applyRemoteContent(node)
                    ) {
                        pendingContentIds.add(id);
                    }
                }
            }

            refreshBacklinks();
        }

        pullCursor = result.latest_seq;
    } finally {
        pulling = false;
    }
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

function handleVisibilityChange() {
    if (document.visibilityState === 'hidden') {
        flushSync();
    }
}

const showDeleteConfirm = ref(false);

async function toggleCurrentPagePin() {
    try {
        await setNodePinned(props.page.id, !pagePinned.value);
    } catch {
        toast.error('Could not update the pinned page.');
    }
}

async function deletePage() {
    const ok = await pushOps([mintNodeDelete(props.page.id, props.page.id)]);
    showDeleteConfirm.value = false;

    if (!ok) {
        toast.error('Could not delete the page — is the app online?');

        return;
    }

    invalidateCachedPage(props.page.id);
    toast.success(`Deleted "${titleContent.value || '[untitled]'}"`);
    router.visit('/pages');
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
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOpsAvailable);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('keydown', handleGlobalKeydown);
    refreshBacklinks();
    pullTimer = setInterval(pollRemoteOps, 1500);

    const requestedBlock = new URLSearchParams(window.location.search).get(
        'block',
    );

    if (requestedBlock) {
        void nextTick(() => pageEditorRef.value?.focusBlock(requestedBlock));
    }
});

onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    window.removeEventListener(
        LOCAL_OPS_AVAILABLE_EVENT,
        handleLocalOpsAvailable,
    );
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('keydown', handleGlobalKeydown);

    if (pullTimer) {
        clearInterval(pullTimer);
        pullTimer = null;
    }

    flushSync();
    markCachedPageInactive(props.page.id);
});
</script>

<template>
    <Head :title="page.content || '[untitled]'" />

    <AppLayout :breadcrumbs="breadcrumbs" :current-page-id="page.id">
        <div class="relative">
            <div class="sticky top-4 z-30 flex h-0 justify-end pr-4">
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="icon" class="shrink-0">
                            <EllipsisVertical class="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem @select="toggleCurrentPagePin">
                            <Pin
                                class="mr-2 h-4 w-4"
                                :class="{ 'fill-current': pagePinned }"
                            />
                            {{ pagePinned ? 'Unpin page' : 'Pin page' }}
                            <DropdownMenuShortcut>
                                {{ bindingLabel('toggle-pin') }}
                            </DropdownMenuShortcut>
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
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
                        @click="startEditingTitle()"
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
                        :auto-focus="editorAutoFocus"
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
