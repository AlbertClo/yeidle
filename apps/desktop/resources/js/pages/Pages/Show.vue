<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import { ref } from 'vue';
import { Plus } from 'lucide-vue-next';
import BlockItem from '@/components/BlockItem.vue';
import AppLayout from '@/layouts/AppLayout.vue';
import { usePageEditor } from '@/composables/usePageEditor';
import type { BreadcrumbItem } from '@/types';
import type { Node, NodeLink } from '@/types/node';

const props = defineProps<{
    page: Node;
    backlinks: NodeLink[];
}>();

const {
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
} = usePageEditor(props.page);

const breadcrumbs: BreadcrumbItem[] = [
    { title: 'Pages', href: '/pages' },
    { title: props.page.content || 'Untitled', href: `/pages/${props.page.id}` },
];

const isEditingTitle = ref(false);
const titleContent = ref(page.value.content);
const titleRef = ref<HTMLInputElement>();

function startEditingTitle(cursorPos?: number) {
    isEditingTitle.value = true;
    titleContent.value = page.value.content;
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
    if (titleContent.value !== page.value.content) {
        updateTitle(titleContent.value);
    }
}

function handleTitleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
        finishEditingTitle();
        return;
    }
    if (e.key === 'ArrowDown') {
        const blocks = flattenBlocks(page.value);
        if (blocks.length > 0) {
            e.preventDefault();
            finishEditingTitle();
            focusBlockId.value = blocks[0].id;
            focusCursorPos.value = 0;
        }
    }
}

function handleAddSibling(afterId: string) {
    const newId = addSibling(afterId);
    if (newId) {
        focusBlockId.value = newId;
        focusCursorPos.value = 0;
    }
}

function handleAddChild(parentId: string) {
    const newId = addChild(parentId);
    if (newId) {
        focusBlockId.value = newId;
        focusCursorPos.value = 0;
    }
}

function handleAddBlock() {
    handleAddChild(page.value.id);
}

function handleFocusBlock(id: string, direction: 'up' | 'down', cursorPos: number) {
    const result = focusBlock(id, direction, cursorPos);
    if (result === 'title') {
        startEditingTitle();
    }
}
</script>

<template>
    <Head :title="page.content || 'Untitled'" />

    <AppLayout :breadcrumbs="breadcrumbs">
        <div class="mx-auto w-full max-w-2xl p-6">
            <div class="mb-6">
                <input
                    v-if="isEditingTitle"
                    ref="titleRef"
                    v-model="titleContent"
                    class="bg-transparent w-full border-none text-3xl font-bold outline-none"
                    @blur="finishEditingTitle"
                    @keydown="handleTitleKeydown"
                />
                <h1
                    v-else
                    class="cursor-text text-3xl font-bold"
                    @click="startEditingTitle"
                >
                    {{ page.content || 'Untitled' }}
                </h1>

                <p
                    v-if="page.url"
                    class="text-muted-foreground mt-1 text-sm"
                >
                    <a
                        :href="page.url"
                        target="_blank"
                        class="hover:underline"
                    >{{ page.url }}</a>
                </p>
            </div>

            <div class="mb-4">
                <BlockItem
                    v-for="child in page.children"
                    :key="child.id"
                    :node="child"
                    :focus-block-id="focusBlockId"
                    :focus-cursor-pos="focusCursorPos"
                    @update="updateContent"
                    @add-child="handleAddChild"
                    @add-sibling="handleAddSibling"
                    @delete="deleteBlock"
                    @merge-with-previous="mergeWithPrevious"
                    @merge-with-next="mergeWithNext"
                    @focus-block="handleFocusBlock"
                    @toggle-check="toggleCheck"
                    @focused="clearFocus"
                />

                <button
                    class="text-muted-foreground hover:text-foreground mt-2 flex items-center gap-1 px-5 text-sm transition-colors"
                    @click="handleAddBlock"
                >
                    <Plus class="h-3.5 w-3.5" />
                    Add block
                </button>
            </div>

            <div
                v-if="backlinks.length > 0"
                class="border-border mt-8 border-t pt-6"
            >
                <h2 class="text-muted-foreground mb-3 text-xs font-semibold uppercase tracking-wider">
                    Backlinks
                </h2>
                <div class="flex flex-col gap-2">
                    <Link
                        v-for="link in backlinks"
                        :key="link.id"
                        :href="`/pages/${link.source_node?.parent_id ?? link.source_node_id}`"
                        class="hover:bg-accent rounded-lg px-3 py-2 text-sm transition-colors"
                    >
                        <span class="text-primary font-medium">
                            {{ link.display_name || link.source_node?.content }}
                        </span>
                    </Link>
                </div>
            </div>
        </div>
    </AppLayout>
</template>
