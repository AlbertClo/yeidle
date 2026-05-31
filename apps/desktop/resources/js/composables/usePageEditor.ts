import * as Y from 'yjs';
import { ref, onBeforeUnmount } from 'vue';
import { router } from '@inertiajs/vue3';
import type { Node } from '@/types/node';

function generateId(): string {
    return crypto.randomUUID();
}

// --- Y.Doc <-> Node conversion ---

function populateYMap(ymap: Y.Map<unknown>, node: Node) {
    ymap.set('id', node.id);
    ymap.set('content', node.content);
    ymap.set('url', node.url);
    ymap.set('is_checked', node.is_checked);
    ymap.set('parent_id', node.parent_id);
    ymap.set('position', node.position);

    const ychildren = new Y.Array<Y.Map<unknown>>();
    for (const child of node.children ?? []) {
        const ychild = new Y.Map<unknown>();
        populateYMap(ychild, child);
        ychildren.push([ychild]);
    }
    ymap.set('children', ychildren);
}

function yMapToNode(ymap: Y.Map<unknown>): Node {
    const ychildren = ymap.get('children') as Y.Array<Y.Map<unknown>> | undefined;
    return {
        id: ymap.get('id') as string,
        content: ymap.get('content') as string,
        url: ymap.get('url') as string | null,
        is_checked: ymap.get('is_checked') as boolean | null,
        parent_id: ymap.get('parent_id') as string | null,
        position: ymap.get('position') as number,
        created_at: '',
        updated_at: '',
        children: ychildren ? ychildren.toArray().map(yMapToNode) : [],
    };
}

// --- Y.Doc tree traversal ---

function findYNode(yroot: Y.Map<unknown>, id: string): Y.Map<unknown> | null {
    if (yroot.get('id') === id) return yroot;
    const ychildren = yroot.get('children') as Y.Array<Y.Map<unknown>> | undefined;
    if (!ychildren) return null;
    for (let i = 0; i < ychildren.length; i++) {
        const found = findYNode(ychildren.get(i), id);
        if (found) return found;
    }
    return null;
}

function findYParentAndIndex(
    yroot: Y.Map<unknown>,
    id: string,
): { parent: Y.Map<unknown>; index: number } | null {
    const ychildren = yroot.get('children') as Y.Array<Y.Map<unknown>> | undefined;
    if (!ychildren) return null;
    for (let i = 0; i < ychildren.length; i++) {
        if (ychildren.get(i).get('id') === id) {
            return { parent: yroot, index: i };
        }
        const found = findYParentAndIndex(ychildren.get(i), id);
        if (found) return found;
    }
    return null;
}

function flattenYBlocks(yroot: Y.Map<unknown>): Y.Map<unknown>[] {
    const result: Y.Map<unknown>[] = [];
    const ychildren = yroot.get('children') as Y.Array<Y.Map<unknown>> | undefined;
    if (!ychildren) return result;
    for (let i = 0; i < ychildren.length; i++) {
        const child = ychildren.get(i);
        result.push(child);
        result.push(...flattenYBlocks(child));
    }
    return result;
}

// --- Sync layer ---

function syncCreate(id: string, parentId: string, content: string, position: number) {
    fetch('/api/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id, parent_id: parentId, content, position }),
    });
}

function syncUpdate(id: string, data: Record<string, unknown>) {
    fetch(`/api/nodes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
    });
}

function syncDelete(id: string) {
    fetch(`/api/nodes/${id}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
    });
}

// --- Composable ---

export function usePageEditor(initialPage: Node) {
    const doc = new Y.Doc();
    const yPage = doc.getMap('page');

    // Initialize Y.Doc from server data
    doc.transact(() => {
        populateYMap(yPage, initialPage);
    });

    // Undo manager — tracks all changes after initialization
    const undoManager = new Y.UndoManager(yPage, { captureTimeout: 200 });

    // Reactive Vue state derived from Y.Doc
    const page = ref<Node>(yMapToNode(yPage));
    const focusBlockId = ref<string | null>(null);
    const focusCursorPos = ref<number | null>(null);

    // Content sync debounce timers
    const contentTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function refreshPage() {
        page.value = yMapToNode(yPage);
    }

    // Observe all Y.Doc changes and update Vue state
    yPage.observeDeep(() => {
        refreshPage();
    });

    function syncContentDebounced(id: string, content: string) {
        const existing = contentTimers.get(id);
        if (existing) clearTimeout(existing);
        contentTimers.set(
            id,
            setTimeout(() => {
                syncUpdate(id, { content });
                contentTimers.delete(id);
            }, 100),
        );
    }

    function flushPendingSyncs() {
        for (const [id, timer] of contentTimers) {
            clearTimeout(timer);
            const ynode = findYNode(yPage, id);
            if (ynode) {
                syncUpdate(id, { content: ynode.get('content') as string });
            }
        }
        contentTimers.clear();
    }

    router.on('before', () => {
        flushPendingSyncs();
    });

    function handleBeforeUnload() {
        flushPendingSyncs();
    }

    window.addEventListener('beforeunload', handleBeforeUnload);

    onBeforeUnmount(() => {
        flushPendingSyncs();
        window.removeEventListener('beforeunload', handleBeforeUnload);
        doc.destroy();
    });

    // --- Tree helpers for Vue layer ---

    function flattenBlocks(node: Node): Node[] {
        const result: Node[] = [];
        for (const child of node.children ?? []) {
            result.push(child);
            result.push(...flattenBlocks(child));
        }
        return result;
    }

    // --- Operations (all mutate Y.Doc, sync is separate) ---

    function updateContent(id: string, content: string) {
        doc.transact(() => {
            const ynode = findYNode(yPage, id);
            if (ynode) ynode.set('content', content);
        });
        syncContentDebounced(id, content);
    }

    function updateTitle(content: string) {
        doc.transact(() => {
            yPage.set('content', content);
        });
        syncContentDebounced(yPage.get('id') as string, content);
    }

    function addChild(parentId: string): string {
        const id = generateId();
        let position = 0;
        doc.transact(() => {
            const yparent = findYNode(yPage, parentId);
            if (!yparent) return;
            const ychildren = yparent.get('children') as Y.Array<Y.Map<unknown>>;
            position = ychildren.length;

            const ynode = new Y.Map<unknown>();
            ynode.set('id', id);
            ynode.set('content', '');
            ynode.set('url', null);
            ynode.set('is_checked', null);
            ynode.set('parent_id', parentId);
            ynode.set('position', position);
            ynode.set('children', new Y.Array<Y.Map<unknown>>());

            ychildren.push([ynode]);
        });
        syncCreate(id, parentId, '', position);
        return id;
    }

    function addSibling(afterId: string): string {
        const id = generateId();
        let parentId = '';
        let position = 0;

        doc.transact(() => {
            const result = findYParentAndIndex(yPage, afterId);
            if (!result) return;
            const { parent, index } = result;
            const ychildren = parent.get('children') as Y.Array<Y.Map<unknown>>;
            parentId = parent.get('id') as string;
            position = index + 1;

            const ynode = new Y.Map<unknown>();
            ynode.set('id', id);
            ynode.set('content', '');
            ynode.set('url', null);
            ynode.set('is_checked', null);
            ynode.set('parent_id', parentId);
            ynode.set('position', position);
            ynode.set('children', new Y.Array<Y.Map<unknown>>());

            ychildren.insert(position, [ynode]);

            // Reindex positions
            for (let i = 0; i < ychildren.length; i++) {
                ychildren.get(i).set('position', i);
            }
        });

        if (parentId) syncCreate(id, parentId, '', position);
        return id;
    }

    function indent(id: string) {
        let newParentId = '';
        let position = 0;

        doc.transact(() => {
            const result = findYParentAndIndex(yPage, id);
            if (!result) return;
            const { parent, index } = result;
            // Can't indent if it's the first child — no sibling above to become parent
            if (index === 0) return;

            const ychildren = parent.get('children') as Y.Array<Y.Map<unknown>>;
            const newParent = ychildren.get(index - 1);
            const newParentChildren = newParent.get('children') as Y.Array<Y.Map<unknown>>;

            // Remove from current parent
            const ynode = ychildren.get(index);
            // Clone the data since we need to delete then re-insert
            const nodeData: Record<string, unknown> = {};
            for (const [key, value] of ynode.entries()) {
                if (key !== 'children') nodeData[key] = value;
            }

            // Collect existing children from the node being moved
            const existingChildren = ynode.get('children') as Y.Array<Y.Map<unknown>>;
            const childMaps: Y.Map<unknown>[] = [];
            for (let i = 0; i < existingChildren.length; i++) {
                childMaps.push(existingChildren.get(i));
            }

            ychildren.delete(index, 1);

            // Reindex old parent's children
            for (let i = 0; i < ychildren.length; i++) {
                ychildren.get(i).set('position', i);
            }

            // Create new Y.Map for the moved node
            const newYNode = new Y.Map<unknown>();
            for (const [key, value] of Object.entries(nodeData)) {
                newYNode.set(key, value);
            }
            newParentId = newParent.get('id') as string;
            position = newParentChildren.length;
            newYNode.set('parent_id', newParentId);
            newYNode.set('position', position);

            // Re-create children array
            const newChildrenArr = new Y.Array<Y.Map<unknown>>();
            newYNode.set('children', newChildrenArr);

            // Add to new parent
            newParentChildren.push([newYNode]);
        });

        if (newParentId) {
            syncUpdate(id, { parent_id: newParentId, position });
        }

        // Keep focus on the same block
        focusBlockId.value = id;
    }

    function outdent(id: string) {
        let newParentId = '';
        let position = 0;

        doc.transact(() => {
            // Find current parent
            const result = findYParentAndIndex(yPage, id);
            if (!result) return;
            const { parent: currentParent, index } = result;
            const currentParentId = currentParent.get('id') as string;

            // Can't outdent if already at root level
            const grandparentResult = findYParentAndIndex(yPage, currentParentId);
            if (!grandparentResult) return;
            const { parent: grandparent, index: parentIndex } = grandparentResult;

            const currentChildren = currentParent.get('children') as Y.Array<Y.Map<unknown>>;
            const grandparentChildren = grandparent.get('children') as Y.Array<Y.Map<unknown>>;

            // Collect node data before removing
            const ynode = currentChildren.get(index);
            const nodeData: Record<string, unknown> = {};
            for (const [key, value] of ynode.entries()) {
                if (key !== 'children') nodeData[key] = value;
            }

            // Remove from current parent
            currentChildren.delete(index, 1);
            for (let i = 0; i < currentChildren.length; i++) {
                currentChildren.get(i).set('position', i);
            }

            // Insert into grandparent right after current parent
            newParentId = grandparent.get('id') as string;
            position = parentIndex + 1;

            const newYNode = new Y.Map<unknown>();
            for (const [key, value] of Object.entries(nodeData)) {
                newYNode.set(key, value);
            }
            newYNode.set('parent_id', newParentId);
            newYNode.set('position', position);
            newYNode.set('children', new Y.Array<Y.Map<unknown>>());

            grandparentChildren.insert(position, [newYNode]);

            // Reindex grandparent's children
            for (let i = 0; i < grandparentChildren.length; i++) {
                grandparentChildren.get(i).set('position', i);
            }
        });

        if (newParentId) {
            syncUpdate(id, { parent_id: newParentId, position });
        }

        focusBlockId.value = id;
    }

    function deleteBlock(id: string) {
        doc.transact(() => {
            const result = findYParentAndIndex(yPage, id);
            if (!result) return;
            const { parent, index } = result;
            const ychildren = parent.get('children') as Y.Array<Y.Map<unknown>>;
            ychildren.delete(index, 1);
            // Reindex
            for (let i = 0; i < ychildren.length; i++) {
                ychildren.get(i).set('position', i);
            }
        });
        syncDelete(id);
    }

    function mergeWithPrevious(id: string, currentContent: string) {
        const yblocks = flattenYBlocks(yPage);
        const idx = yblocks.findIndex((b) => b.get('id') === id);
        if (idx <= 0) return;

        const prevYBlock = yblocks[idx - 1];
        const prevId = prevYBlock.get('id') as string;
        const prevContent = prevYBlock.get('content') as string;
        const cursorPos = prevContent.length;
        const mergedContent = prevContent + currentContent;

        // Flush pending content save for previous block
        const timer = contentTimers.get(prevId);
        if (timer) {
            clearTimeout(timer);
            contentTimers.delete(prevId);
        }

        doc.transact(() => {
            prevYBlock.set('content', mergedContent);

            const result = findYParentAndIndex(yPage, id);
            if (result) {
                const ychildren = result.parent.get('children') as Y.Array<Y.Map<unknown>>;
                ychildren.delete(result.index, 1);
                for (let i = 0; i < ychildren.length; i++) {
                    ychildren.get(i).set('position', i);
                }
            }
        });

        syncUpdate(prevId, { content: mergedContent });
        syncDelete(id);

        focusBlockId.value = prevId;
        focusCursorPos.value = cursorPos;
    }

    function mergeWithNext(id: string, currentContent: string, cursorPos: number) {
        const yblocks = flattenYBlocks(yPage);
        const idx = yblocks.findIndex((b) => b.get('id') === id);
        if (idx === -1 || idx >= yblocks.length - 1) return;

        const currentYBlock = yblocks[idx];
        const nextYBlock = yblocks[idx + 1];
        const nextId = nextYBlock.get('id') as string;
        const nextContent = nextYBlock.get('content') as string;
        const mergedContent = currentContent + nextContent;

        // Flush pending content save
        const timer = contentTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            contentTimers.delete(id);
        }

        doc.transact(() => {
            currentYBlock.set('content', mergedContent);

            const result = findYParentAndIndex(yPage, nextId);
            if (result) {
                const ychildren = result.parent.get('children') as Y.Array<Y.Map<unknown>>;
                ychildren.delete(result.index, 1);
                for (let i = 0; i < ychildren.length; i++) {
                    ychildren.get(i).set('position', i);
                }
            }
        });

        syncUpdate(id, { content: mergedContent });
        syncDelete(nextId);

        focusBlockId.value = id;
        focusCursorPos.value = cursorPos;
    }

    function toggleCheck(id: string, checked: boolean | null) {
        doc.transact(() => {
            const ynode = findYNode(yPage, id);
            if (ynode) ynode.set('is_checked', checked);
        });
        syncUpdate(id, { is_checked: checked });
    }

    function focusBlock(id: string, direction: 'up' | 'down', cursorPos: number) {
        const blocks = flattenBlocks(page.value);
        const idx = blocks.findIndex((n) => n.id === id);
        if (idx === -1) return;

        if (direction === 'up' && idx === 0) {
            return 'title';
        }

        if (direction === 'down' && idx === blocks.length - 1) {
            focusBlockId.value = blocks[idx].id;
            focusCursorPos.value = blocks[idx].content.length;
            return;
        }

        const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
        const target = blocks[targetIdx];
        focusBlockId.value = target.id;
        focusCursorPos.value = Math.min(cursorPos, target.content.length);
    }

    function undo() {
        undoManager.undo();
    }

    function redo() {
        undoManager.redo();
    }

    function clearFocus() {
        focusBlockId.value = null;
        focusCursorPos.value = null;
    }

    return {
        page,
        focusBlockId,
        focusCursorPos,
        flattenBlocks,
        updateContent,
        updateTitle,
        addChild,
        addSibling,
        deleteBlock,
        indent,
        outdent,
        mergeWithPrevious,
        mergeWithNext,
        toggleCheck,
        focusBlock,
        clearFocus,
        undo,
        redo,
    };
}
