import { ref, onBeforeUnmount } from 'vue';
import { router } from '@inertiajs/vue3';
import type { Node } from '@/types/node';

function generateId(): string {
    // UUIDv7-like: timestamp-based for ordering, random suffix
    const now = Date.now();
    const hex = now.toString(16).padStart(12, '0');
    const rand = () => Math.random().toString(16).slice(2, 6);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand().slice(0, 3)}-${rand()}-${rand()}${rand()}${rand()}`.slice(0, 36);
}

function deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj));
}

export function usePageEditor(initialPage: Node) {
    const page = ref<Node>(deepClone(initialPage));
    const focusBlockId = ref<string | null>(null);
    const focusCursorPos = ref<number | null>(null);

    // Debounce timers per block for content saves
    const contentTimers = new Map<string, ReturnType<typeof setTimeout>>();

    // --- Tree helpers ---

    function flattenBlocks(node: Node): Node[] {
        const result: Node[] = [];
        for (const child of node.children ?? []) {
            result.push(child);
            result.push(...flattenBlocks(child));
        }
        return result;
    }

    function findNode(root: Node, id: string): Node | null {
        if (root.id === id) return root;
        for (const child of root.children ?? []) {
            const found = findNode(child, id);
            if (found) return found;
        }
        return null;
    }

    function findParent(root: Node, id: string): Node | null {
        for (const child of root.children ?? []) {
            if (child.id === id) return root;
            const found = findParent(child, id);
            if (found) return found;
        }
        return null;
    }

    function removeNode(root: Node, id: string): Node | null {
        const parent = findParent(root, id);
        if (!parent?.children) return null;
        const idx = parent.children.findIndex((c) => c.id === id);
        if (idx === -1) return null;
        const [removed] = parent.children.splice(idx, 1);
        // Reindex positions
        parent.children.forEach((c, i) => (c.position = i));
        return removed;
    }

    // --- Sync layer ---

    function syncCreate(node: Node, parentId: string) {
        fetch('/api/nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
                id: node.id,
                parent_id: parentId,
                content: node.content,
                position: node.position,
                url: node.url,
                is_checked: node.is_checked,
            }),
        });
    }

    function syncUpdate(id: string, data: Partial<Node>) {
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

    function syncContentDebounced(id: string, content: string) {
        const existing = contentTimers.get(id);
        if (existing) clearTimeout(existing);
        contentTimers.set(
            id,
            setTimeout(() => {
                syncUpdate(id, { content });
                contentTimers.delete(id);
            }, 500),
        );
    }

    function flushPendingSyncs() {
        for (const [id, timer] of contentTimers) {
            clearTimeout(timer);
            const node = findNode(page.value, id);
            if (node) {
                syncUpdate(id, { content: node.content });
            }
        }
        contentTimers.clear();
    }

    // Flush on navigation
    router.on('before', () => {
        flushPendingSyncs();
    });

    onBeforeUnmount(() => {
        flushPendingSyncs();
    });

    // --- Operations ---

    function updateContent(id: string, content: string) {
        const node = findNode(page.value, id);
        if (!node) return;
        node.content = content;
        syncContentDebounced(id, content);
    }

    function updateTitle(content: string) {
        page.value.content = content;
        syncContentDebounced(page.value.id, content);
    }

    function addChild(parentId: string): string {
        const parent = findNode(page.value, parentId);
        if (!parent) return '';
        if (!parent.children) parent.children = [];

        const newNode: Node = {
            id: generateId(),
            parent_id: parentId,
            position: parent.children.length,
            content: '',
            url: null,
            is_checked: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            children: [],
        };

        parent.children.push(newNode);
        syncCreate(newNode, parentId);
        return newNode.id;
    }

    function addSibling(afterId: string): string {
        const parent = findParent(page.value, afterId);
        if (!parent?.children) return '';

        const idx = parent.children.findIndex((c) => c.id === afterId);
        if (idx === -1) return '';

        const parentId = parent.id;
        const newNode: Node = {
            id: generateId(),
            parent_id: parentId,
            position: idx + 1,
            content: '',
            url: null,
            is_checked: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            children: [],
        };

        parent.children.splice(idx + 1, 0, newNode);
        // Reindex
        parent.children.forEach((c, i) => (c.position = i));
        syncCreate(newNode, parentId);
        return newNode.id;
    }

    function deleteBlock(id: string) {
        removeNode(page.value, id);
        syncDelete(id);
    }

    function mergeWithPrevious(id: string, currentContent: string) {
        const blocks = flattenBlocks(page.value);
        const idx = blocks.findIndex((n) => n.id === id);
        if (idx <= 0) return;

        const prevBlock = blocks[idx - 1];
        const cursorPos = prevBlock.content.length;
        prevBlock.content += currentContent;

        // Flush any pending content save for the previous block
        const timer = contentTimers.get(prevBlock.id);
        if (timer) {
            clearTimeout(timer);
            contentTimers.delete(prevBlock.id);
        }

        removeNode(page.value, id);

        syncUpdate(prevBlock.id, { content: prevBlock.content });
        syncDelete(id);

        focusBlockId.value = prevBlock.id;
        focusCursorPos.value = cursorPos;
    }

    function mergeWithNext(id: string, currentContent: string, cursorPos: number) {
        const blocks = flattenBlocks(page.value);
        const idx = blocks.findIndex((n) => n.id === id);
        if (idx === -1 || idx >= blocks.length - 1) return;

        const currentBlock = blocks[idx];
        const nextBlock = blocks[idx + 1];

        currentBlock.content = currentContent + nextBlock.content;

        // Flush any pending content save
        const timer = contentTimers.get(id);
        if (timer) {
            clearTimeout(timer);
            contentTimers.delete(id);
        }

        removeNode(page.value, nextBlock.id);

        syncUpdate(id, { content: currentBlock.content });
        syncDelete(nextBlock.id);

        focusBlockId.value = id;
        focusCursorPos.value = cursorPos;
    }

    function toggleCheck(id: string, checked: boolean | null) {
        const node = findNode(page.value, id);
        if (!node) return;
        node.is_checked = checked;
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
        mergeWithPrevious,
        mergeWithNext,
        toggleCheck,
        focusBlock,
        clearFocus,
    };
}
