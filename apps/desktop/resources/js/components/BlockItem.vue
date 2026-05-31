<script setup lang="ts">
import { ref, nextTick, onMounted, watch } from 'vue';
import { ChevronRight, Square, SquareCheck } from 'lucide-vue-next';
import type { Node } from '@/types/node';

const props = defineProps<{
    node: Node;
    depth?: number;
    focusBlockId?: string | null;
    focusCursorPos?: number | null;
}>();

const emit = defineEmits<{
    update: [id: string, content: string];
    addChild: [parentId: string];
    addSibling: [afterId: string];
    delete: [id: string];
    indent: [id: string];
    outdent: [id: string];
    mergeWithPrevious: [id: string, remainingContent: string];
    mergeWithNext: [id: string, currentContent: string, cursorPos: number];
    toggleCheck: [id: string, checked: boolean | null];
    focusBlock: [id: string, direction: 'up' | 'down', cursorPos: number];
    focused: [];
}>();

const depth = props.depth ?? 0;
const isExpanded = ref(true);
const isEditing = ref(false);
const editContent = ref(props.node.content);
const inputRef = ref<HTMLTextAreaElement>();
const skipBlur = ref(false);

function startEditing(cursorPos?: number) {
    isEditing.value = true;
    editContent.value = props.node.content;
    nextTick(() => {
        if (inputRef.value) {
            inputRef.value.focus();
            if (cursorPos !== undefined && cursorPos !== null) {
                inputRef.value.setSelectionRange(cursorPos, cursorPos);
            }
        }
    });
}

function handleBlur() {
    // Don't exit edit mode if the window itself lost focus
    if (!document.hasFocus()) return;

    if (skipBlur.value) {
        skipBlur.value = false;
        return;
    }
    isEditing.value = false;
    if (editContent.value !== props.node.content) {
        emit('update', props.node.id, editContent.value);
    }
}

function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Save current content first
        if (editContent.value !== props.node.content) {
            emit('update', props.node.id, editContent.value);
        }
        skipBlur.value = true;
        isEditing.value = false;
        emit('addSibling', props.node.id);
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        if (editContent.value !== props.node.content) {
            emit('update', props.node.id, editContent.value);
        }
        if (e.shiftKey) {
            emit('outdent', props.node.id);
        } else {
            emit('indent', props.node.id);
        }
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const textarea = inputRef.value;
        if (!textarea) return;
        const cursorPos = textarea.selectionStart;

        if (editContent.value !== props.node.content) {
            emit('update', props.node.id, editContent.value);
        }
        skipBlur.value = true;
        isEditing.value = false;
        emit('focusBlock', props.node.id, e.key === 'ArrowUp' ? 'up' : 'down', cursorPos);
        return;
    }
    if (e.key === 'Backspace') {
        const textarea = inputRef.value;
        if (!textarea) return;
        if (textarea.selectionStart === 0 && textarea.selectionEnd === 0) {
            e.preventDefault();
            // Save content, exit edit mode, then emit merge request
            // The composable will set focusBlockId to the previous block
            // If this is the first block, composable does nothing — we re-focus ourselves
            if (editContent.value !== props.node.content) {
                emit('update', props.node.id, editContent.value);
            }
            skipBlur.value = true;
            isEditing.value = false;
            emit('mergeWithPrevious', props.node.id, editContent.value);
            // If we're still here (first block, no merge happened), re-enter edit mode
            if (!props.focusBlockId || props.focusBlockId === props.node.id) {
                startEditing(0);
            }
        }
    }
    if (e.key === 'Delete') {
        const textarea = inputRef.value;
        if (!textarea) return;
        if (textarea.selectionStart === editContent.value.length && textarea.selectionEnd === editContent.value.length) {
            e.preventDefault();
            emit('mergeWithNext', props.node.id, editContent.value, textarea.selectionStart);
            // If no merge happened (last block), re-focus at end
            if (!props.focusBlockId || props.focusBlockId === props.node.id) {
                startEditing(editContent.value.length);
            }
        }
    }
}

function toggleExpand() {
    isExpanded.value = !isExpanded.value;
}

function cycleCheck() {
    if (props.node.is_checked === null) {
        emit('toggleCheck', props.node.id, false);
    } else if (props.node.is_checked === false) {
        emit('toggleCheck', props.node.id, true);
    } else {
        emit('toggleCheck', props.node.id, null);
    }
}

function renderContent(content: string): string {
    return content.replace(
        /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g,
        (_match, target, display) => {
            const label = display || target;
            return `<span class="text-primary cursor-pointer font-medium underline decoration-primary/30 hover:decoration-primary">${label}</span>`;
        },
    );
}

function tryAutoFocus() {
    if (props.focusBlockId === props.node.id) {
        startEditing(props.focusCursorPos ?? undefined);
        emit('focused');
    }
}

onMounted(tryAutoFocus);
watch(() => props.focusBlockId, tryAutoFocus);

// Keep editContent in sync when node.content changes from outside
watch(() => props.node.content, (newVal) => {
    if (!isEditing.value) {
        editContent.value = newVal;
    }
});
</script>

<template>
    <div class="group">
        <div
            class="flex items-start gap-0.5 rounded py-0.5"
            :style="{ paddingLeft: `${depth * 24}px` }"
        >
            <button
                v-if="node.children && node.children.length > 0"
                class="text-muted-foreground hover:text-foreground mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors"
                @click="toggleExpand"
            >
                <ChevronRight
                    class="h-3.5 w-3.5 transition-transform"
                    :class="{ 'rotate-90': isExpanded }"
                />
            </button>
            <div v-else class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                <div class="bg-foreground/30 h-1.5 w-1.5 rounded-full" />
            </div>

            <button
                v-if="node.is_checked !== null"
                class="text-muted-foreground hover:text-foreground mt-0.5 mr-1 shrink-0"
                @click="cycleCheck"
            >
                <SquareCheck v-if="node.is_checked" class="h-4 w-4 text-green-500" />
                <Square v-else class="h-4 w-4" />
            </button>

            <div class="min-w-0 flex-1">
                <textarea
                    v-if="isEditing"
                    ref="inputRef"
                    v-model="editContent"
                    class="bg-transparent m-0 block w-full resize-none border-none p-0 text-sm leading-relaxed outline-none"
                    rows="1"
                    style="height: 1.625em; overflow: hidden"
                    @blur="handleBlur"
                    @keydown="handleKeydown"
                />
                <div
                    v-else
                    class="cursor-text text-sm leading-relaxed"
                    :class="{ 'text-muted-foreground line-through': node.is_checked }"
                    @click="startEditing()"
                    v-html="renderContent(node.content) || '&nbsp;'"
                />
            </div>
        </div>

        <div v-if="isExpanded && node.children && node.children.length > 0">
            <BlockItem
                v-for="child in node.children"
                :key="child.id"
                :node="child"
                :depth="depth + 1"
                :focus-block-id="focusBlockId"
                :focus-cursor-pos="focusCursorPos"
                @update="(id, content) => $emit('update', id, content)"
                @add-child="(parentId) => $emit('addChild', parentId)"
                @add-sibling="(afterId) => $emit('addSibling', afterId)"
                @delete="(id) => $emit('delete', id)"
                @indent="(id) => $emit('indent', id)"
                @outdent="(id) => $emit('outdent', id)"
                @merge-with-previous="(id, content) => $emit('mergeWithPrevious', id, content)"
                @merge-with-next="(id, content, pos) => $emit('mergeWithNext', id, content, pos)"
                @focus-block="(id, dir, pos) => $emit('focusBlock', id, dir, pos)"
                @toggle-check="(id, checked) => $emit('toggleCheck', id, checked)"
                @focused="$emit('focused')"
            />
        </div>
    </div>
</template>
