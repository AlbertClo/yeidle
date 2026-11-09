<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { applyBlocks, createDoc, readBlocks } from '@yeidle/core/loro/pageDoc';

// Phase 0 checks: Loro's WebAssembly loads in the renderer, and the main
// process can open SQLite with FTS5
const loro = ref('…');
const sqlite = ref('…');

onMounted(async () => {
    try {
        const doc = createDoc();
        applyBlocks(doc, [
            {
                id: 'spike',
                parent_id: 'page',
                position: 'a0',
                content: 'hello from Loro',
                tiptap_content: {
                    type: 'paragraph',
                    content: [{ type: 'text', text: 'hello from Loro' }],
                },
                is_checked: null,
            },
        ]);
        doc.commit();
        loro.value = `ok: ${readBlocks(doc, 'page')[0].content}`;
    } catch (error) {
        loro.value = `failed: ${String(error)}`;
    }

    try {
        const result = await window.yeidle.spikeSqlite();
        sqlite.value = `ok: SQLite ${result.version}, ${result.hits.length} search hit`;
    } catch (error) {
        sqlite.value = `failed: ${String(error)}`;
    }
});
</script>

<template>
    <main>
        <h1>Yeidle</h1>
        <p data-check="loro">Loro: {{ loro }}</p>
        <p data-check="sqlite">SQLite: {{ sqlite }}</p>
    </main>
</template>
