<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import {
    ChevronLeft,
    ChevronRight,
    ChevronsDown,
    EllipsisVertical,
    Pin,
    Trash2,
} from 'lucide-vue-next';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
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
import {
    adjacentDate,
    openDailyNote,
    startDailyNoteTraversal,
} from '@/dailyNotes';
import type { DailyNoteFocus } from '@/dailyNotes';
import AppLayout from '@/layouts/AppLayout.vue';
import {
    isHistoryNavigation,
    prepareEditorNavigation,
    recalledEditorSelection,
    rememberEditorSelection,
    restoreNavigationScrollPosition,
} from '@/navigation/historyNavigation';
import type { EditorSelectionBookmark } from '@/navigation/historyNavigation';
import { hasSavedMainScrollPosition } from '@/navigation/scrollRestoration';
import {
    initializeCollapsedNodes,
    loadCollapsedNodes,
    opsAffectCollapsedNodes,
} from '@/stores/collapsedNodes';
import { bindingLabel, eventMatchesCommand } from '@/stores/keyBindings';
import {
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
import { DocumentSession } from '@/sync/documentSession';
import type { DocumentState } from '@/sync/documentSession';
import {
    documentsInEvent,
    LOCAL_OPS_AVAILABLE_EVENT,
} from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';
import { createMaxWaitScheduler } from '@/sync/maxWaitScheduler';
import { notifyLocalNodesChanged } from '@/sync/nodeChanges';
import { applyBlocks, readBlocks } from '@yeidle/core/loro/pageDoc';
import type { Block } from '@yeidle/core/loro/pageDoc';
import { readPageMeta, updatePageMeta } from '@yeidle/core/loro/pageMeta';
import { canonicalJson } from '@yeidle/core/loro/richText';
import type { BreadcrumbItem } from '@/types';
import type { Node } from '@/types/node';
import { hasOpenModal } from '@/ui/modal';

const props = defineProps<{
    page: Node;
    pinned: boolean;
    backlinks: { id: string; page_id: string; page_title: string }[];
    document: DocumentState;
    collapsedNodeIds: string[];
    collapsedNodesRootId: string;
}>();

initializeCollapsedNodes(props.collapsedNodesRootId, props.collapsedNodeIds);

markCachedPageActive(props.page.id);
rememberPinState({ ...props.page, children: undefined }, props.pinned);

const isEditingTitle = ref(false);
// The page's Loro document is the source of truth for the editor; the
// Inertia props only seed it
const session = DocumentSession.fromState(props.document);

function blocksToNodes(blocks: Block[]): Node[] {
    return blocks.map((block) => ({
        id: block.id,
        parent_id: block.parent_id,
        position: block.position,
        content: block.content,
        tiptap_content: block.tiptap_content as Node['tiptap_content'],
        is_checked: block.is_checked,
        modified_hlc: '',
        created_at: block.created_at ?? '',
        updated_at: '',
        children: blocksToNodes(block.children ?? []),
    }));
}

function documentNodes(): Node[] {
    return blocksToNodes(readBlocks(session.doc, props.page.id));
}

const titleContent = ref(readPageMeta(session.doc).title || props.page.content);
const pageNodes = ref<Node[]>(documentNodes());
const pageBacklinks = ref(props.backlinks);
const editorKey = ref(0);
const pagePinned = computed(() => isNodePinned(props.page.id));
const isDailyNote = computed(
    () =>
        props.page.page_type === 'daily_note' &&
        props.page.daily_note_date !== null,
);
const breadcrumbs = computed<BreadcrumbItem[]>(() => [
    { title: 'All Pages', href: '/pages' },
    {
        title: titleContent.value || '[untitled]',
        href: `/pages/${props.page.id}`,
    },
]);
const titleRef = ref<HTMLInputElement>();
type PageEditorHandle = {
    focusStart: () => void;
    focusBlock: (blockId: string) => void;
    selectionBlockId: () => string | null;
    applyRemoteContent: (node: Node) => boolean;
    expandAllPageNodes: () => boolean;
};

const pageEditorRef = ref<PageEditorHandle>();
const requestedBlock = ref(
    typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('block'),
);
const requestedDailyNoteFocus = (() => {
    if (typeof window === 'undefined') {
        return null;
    }

    const focus = new URLSearchParams(window.location.search).get('dailyFocus');

    return focus === 'start' || focus === 'end' ? focus : null;
})();
const editorHistoryKey =
    typeof window === 'undefined'
        ? `/pages/${props.page.id}`
        : `${window.location.pathname}${window.location.search}`;
const restoringHistoryNavigation = isHistoryNavigation();
const initialEditorSelection = ref<EditorSelectionBookmark | null>(
    restoringHistoryNavigation
        ? recalledEditorSelection(editorHistoryKey)
        : null,
);
const restoringHistoryPosition =
    restoringHistoryNavigation || hasSavedMainScrollPosition();
const progressiveInitialNodeCount =
    restoringHistoryPosition || requestedDailyNoteFocus ? 0 : 40;

let navigatingDailyNoteBoundary = false;
const syncScheduler = createMaxWaitScheduler(() => flushLocal(), 300, 1000);

function startEditingTitle(cursorPos?: number) {
    if (isDailyNote.value) {
        return;
    }

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
//
// The editor and the page's Loro document must always agree, except for
// local edits not yet flushed into the document. Every flush diffs the
// editor tree against the document; remote updates are imported only right
// after a flush, and then applied to the editor in the same tick.

let lastSavedTitle = props.page.content;
const titleError = ref(false);
const titleSyncScheduler = createMaxWaitScheduler(
    () => void saveTitle(),
    300,
    1000,
);

// Advisory only: duplicate titles are a soft constraint, so the client warns
// instead of the app rejecting
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
    session.change((doc) => updatePageMeta(doc, { title }));

    setCachedPage(props.page.id, title, editorNodes);
    updatePinnedItemTitle(props.page.id, title);
}

function syncTitleDebounced() {
    titleSyncScheduler.schedule();
}

// The tree the editor currently shows, and the latest unflushed emit
let editorNodes: Node[] = pageNodes.value;
let pendingNodes: Node[] | null = null;
// Each block's content as last written to the document, to skip unchanged
// blocks when diffing
const flushedContent = new Map<string, string>();

function contentKey(node: Node): string {
    return canonicalJson(node.tiptap_content ?? null);
}

function rememberContent(nodes: Node[]) {
    for (const node of nodes) {
        flushedContent.set(node.id, contentKey(node));
        rememberContent(node.children ?? []);
    }
}
rememberContent(editorNodes);

/** Writes unflushed editor changes into the document (synchronous). */
function flushLocal() {
    syncScheduler.cancel();

    if (pendingNodes === null) {
        return;
    }

    const nodes = pendingNodes;
    pendingNodes = null;
    const contentChanged: string[] = [];
    const changed = session.change((doc) =>
        applyBlocks(doc, nodes as unknown as Block[], {
            contentChanged: (block) => {
                const node = block as unknown as Node;
                const key = contentKey(node);

                if (flushedContent.get(node.id) === key) {
                    return false;
                }

                flushedContent.set(node.id, key);
                contentChanged.push(node.id);

                return true;
            },
        }),
    );

    if (changed) {
        notifyLocalNodesChanged(contentChanged);

        if (contentChanged.length > 0) {
            refreshBacklinks();
        }
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

function flushSync() {
    titleSyncScheduler.flush();
    flushLocal();
    void session.send();
}

function handleNodesUpdate(nodes: Node[]) {
    editorNodes = nodes;
    pendingNodes = nodes;
    setCachedPage(props.page.id, titleContent.value, nodes);
    syncScheduler.schedule();
}

function handleLocalOpsAvailable(event: Event) {
    const detail = (event as LocalOpsAvailableEvent).detail;

    if (opsAffectCollapsedNodes(detail?.ops ?? null)) {
        void loadCollapsedNodes(true);
    }

    const documents = documentsInEvent(detail?.ops ?? null);

    if (documents === null || documents.includes(props.page.id)) {
        void pullRemote();
    }
}

// --- Remote changes: import and apply to the live editor ---

let pulling = false;
let pullAgain = false;
const editorAutoFocus = ref(!restoringHistoryPosition);
let lastSelection: EditorSelectionBookmark | null = null;

type Shape = { id: string; parent: string | null; children: string[] };

function shapeOf(nodes: Node[], parent: string | null, into: Map<string, Shape>) {
    for (const node of nodes) {
        into.set(node.id, {
            id: node.id,
            parent,
            children: (node.children ?? []).map((child) => child.id),
        });
        shapeOf(node.children ?? [], node.id, into);
    }

    return into;
}

function sameStructure(a: Node[], b: Node[]): boolean {
    if (a.map((n) => n.id).join() !== b.map((n) => n.id).join()) {
        return false;
    }

    const left = shapeOf(a, null, new Map());
    const right = shapeOf(b, null, new Map());

    if (left.size !== right.size) {
        return false;
    }

    for (const [id, shape] of left) {
        const other = right.get(id);

        if (
            !other ||
            other.parent !== shape.parent ||
            other.children.join() !== shape.children.join()
        ) {
            return false;
        }
    }

    return true;
}

function flatten(nodes: Node[], into: Node[] = []): Node[] {
    for (const node of nodes) {
        into.push(node);
        flatten(node.children ?? [], into);
    }

    return into;
}

async function pullRemote() {
    if (pulling) {
        pullAgain = true;

        return;
    }

    pulling = true;

    try {
        const importUpdates = await session.fetchUpdates();

        if (!importUpdates) {
            return;
        }

        // Same tick from here on: flush, import, apply
        flushLocal();

        if (!importUpdates()) {
            return;
        }

        const meta = readPageMeta(session.doc);

        if (!isEditingTitle.value && meta.title !== titleContent.value) {
            titleContent.value = meta.title;
            lastSavedTitle = meta.title;
            updatePinnedItemTitle(props.page.id, meta.title);
        }

        const remote = documentNodes();

        if (!sameStructure(editorNodes, remote)) {
            remountEditor(remote);
        } else {
            const current = new Map(
                flatten(editorNodes).map((node) => [node.id, node]),
            );

            for (const node of flatten(remote)) {
                const shown = current.get(node.id);

                if (
                    shown &&
                    contentKey(shown) === contentKey(node) &&
                    (shown.is_checked ?? null) === (node.is_checked ?? null)
                ) {
                    continue;
                }

                if (!pageEditorRef.value?.applyRemoteContent(node)) {
                    remountEditor(remote);

                    break;
                }
            }

            editorNodes = remote;
        }

        rememberContent(remote);
        setCachedPage(props.page.id, titleContent.value, remote);
        refreshBacklinks();
    } finally {
        pulling = false;

        if (pullAgain) {
            pullAgain = false;
            void pullRemote();
        }
    }
}

/** Structural remote change: re-render, restoring the selection. */
function remountEditor(nodes: Node[]) {
    const hadFocus = pageEditorRef.value?.selectionBlockId() != null;
    initialEditorSelection.value = hadFocus ? lastSelection : null;
    editorAutoFocus.value = hadFocus;
    pageNodes.value = nodes;
    editorNodes = nodes;
    editorKey.value++;
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

function openAdjacentDailyNote(offset: -1 | 1): void {
    if (!props.page.daily_note_date) {
        return;
    }

    void openDailyNote(adjacentDate(props.page.daily_note_date, offset)).catch(
        () => showAdjacentDailyNoteError(offset),
    );
}

async function crossDailyNoteBoundary(
    offset: -1 | 1,
    focus: DailyNoteFocus,
): Promise<void> {
    if (!props.page.daily_note_date || navigatingDailyNoteBoundary) {
        return;
    }

    navigatingDailyNoteBoundary = true;

    try {
        await openDailyNote(
            adjacentDate(props.page.daily_note_date, offset),
            focus,
        );
    } catch {
        navigatingDailyNoteBoundary = false;
        showAdjacentDailyNoteError(offset);
    }
}

function showAdjacentDailyNoteError(offset: -1 | 1): void {
    toast.error(
        offset < 0
            ? 'Could not open the previous daily note.'
            : 'Could not open the next daily note.',
    );
}

async function deletePage() {
    flushLocal();
    session.change((doc) => updatePageMeta(doc, { deleted: true }));
    const ok = await session.send();
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
    if (hasOpenModal()) {
        return;
    }

    if (
        isDailyNote.value &&
        props.page.daily_note_date &&
        eventMatchesCommand(e, 'previous-daily-note')
    ) {
        e.preventDefault();
        startDailyNoteTraversal(props.page.daily_note_date, -1, () =>
            showAdjacentDailyNoteError(-1),
        );

        return;
    }

    if (
        isDailyNote.value &&
        props.page.daily_note_date &&
        eventMatchesCommand(e, 'next-daily-note')
    ) {
        e.preventDefault();
        startDailyNoteTraversal(props.page.daily_note_date, 1, () =>
            showAdjacentDailyNoteError(1),
        );

        return;
    }

    const entersEditor =
        (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey;

    if (entersEditor && !isEditingTitle.value) {
        const target = e.target as HTMLElement;

        if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
            return;
        }

        // Don't intercept if the editor already has focus
        if (target.closest('.ProseMirror')) {
            return;
        }

        e.preventDefault();
        pageEditorRef.value?.focusStart();
    }
}

function handleEditorSelectionChange(selection: EditorSelectionBookmark): void {
    lastSelection = selection;
    rememberEditorSelection(editorHistoryKey, selection);
}

function handleEditorNavigationDeparture(
    selection: EditorSelectionBookmark,
): void {
    prepareEditorNavigation(editorHistoryKey, selection);
}

onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload);
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOpsAvailable);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('keydown', handleGlobalKeydown);
    restoreNavigationScrollPosition();
    // Catch anything that changed while the page was cached
    void pullRemote();
});

onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload);
    window.removeEventListener(
        LOCAL_OPS_AVAILABLE_EVENT,
        handleLocalOpsAvailable,
    );
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    document.removeEventListener('keydown', handleGlobalKeydown);
    flushSync();
    markCachedPageInactive(props.page.id);
});
</script>

<template>
    <Head :title="page.content || '[untitled]'" />

    <AppLayout
        :breadcrumbs="breadcrumbs"
        :current-page-id="page.id"
        :current-page-type="page.page_type"
    >
        <div class="relative">
            <div class="sticky top-4 z-30 flex h-0 justify-end pr-4">
                <DropdownMenu>
                    <DropdownMenuTrigger as-child>
                        <Button variant="outline" size="icon" class="shrink-0">
                            <EllipsisVertical class="h-4 w-4" />
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuItem
                            @select="pageEditorRef?.expandAllPageNodes()"
                        >
                            <ChevronsDown class="mr-2 h-4 w-4" />
                            Expand all
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
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
                    <div
                        v-if="isDailyNote && page.daily_note_date"
                        class="mb-3 flex items-center gap-1"
                    >
                        <Button
                            variant="ghost"
                            size="icon"
                            :title="`Previous daily note (${bindingLabel('previous-daily-note')})`"
                            aria-label="Previous daily note"
                            @click="openAdjacentDailyNote(-1)"
                        >
                            <ChevronLeft class="h-4 w-4" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            :title="`Next daily note (${bindingLabel('next-daily-note')})`"
                            aria-label="Next daily note"
                            @click="openAdjacentDailyNote(1)"
                        >
                            <ChevronRight class="h-4 w-4" />
                        </Button>
                    </div>
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
                        class="text-3xl font-bold"
                        :class="[
                            { 'text-red-500': titleError },
                            isDailyNote ? 'cursor-default' : 'cursor-text',
                        ]"
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
                        :progressive-initial-node-count="
                            progressiveInitialNodeCount
                        "
                        :initial-focus-block-id="requestedBlock"
                        :initial-selection="initialEditorSelection"
                        :initial-focus-boundary="requestedDailyNoteFocus"
                        :navigate-across-daily-notes="isDailyNote"
                        @update="handleNodesUpdate"
                        @focus-title="startEditingTitle()"
                        @focus-backlinks="focusFirstBacklink"
                        @initial-focus-applied="requestedBlock = null"
                        @initial-selection-applied="
                            initialEditorSelection = null
                        "
                        @selection-change="handleEditorSelectionChange"
                        @navigation-departure="handleEditorNavigationDeparture"
                        @daily-note-boundary="crossDailyNoteBoundary"
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
                            @keydown.down.stop.prevent="
                                focusNextBacklink($event)
                            "
                            @keydown.up.stop.prevent="focusPrevBacklink($event)"
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
