<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import BlockItem from './BlockItem.vue';
import type { BlockTree } from './BlockItem.vue';
import {
    api,
    closeBrowser,
    coreReady,
    onDocumentsChanged,
} from './core/client';

/**
 * The prototype's screens: sign in, pick a workspace, list and search its
 * pages, read a page. Everything goes through the core's JSON API, the
 * same one the desktop app uses.
 */

type Account = {
    signed_in: boolean;
    user: { name?: string; email?: string } | null;
};
type Workspace = { id: string; name: string; cloud_status: string };
type WorkspaceState = { active_workspace_id: string; workspaces: Workspace[] };
type Page = {
    id: string;
    title: string;
    kind: 'page' | 'daily';
    daily_date: string | null;
    updated_at: number;
};
type SearchResult = {
    kind: 'page' | 'block';
    id: string;
    page_id: string;
    text: string;
};

const status = ref<'starting' | 'ready' | 'failed'>('starting');
const startError = ref('');
const account = ref<Account | null>(null);
const workspaceState = ref<WorkspaceState | null>(null);
const pages = ref<Page[]>([]);
const query = ref('');
const results = ref<SearchResult[]>([]);
const openPage = ref<{ id: string; title: string; blocks: BlockTree[] } | null>(
    null,
);
const busy = ref('');
const error = ref('');
const signingIn = ref(false);
let approvalPoll: ReturnType<typeof setInterval> | null = null;

const activeWorkspace = computed(
    () =>
        workspaceState.value?.workspaces.find(
            (workspace) =>
                workspace.id === workspaceState.value?.active_workspace_id,
        ) ?? null,
);

async function run(label: string, task: () => Promise<void>): Promise<void> {
    busy.value = label;
    error.value = '';

    try {
        await task();
    } catch (reason) {
        error.value = reason instanceof Error ? reason.message : String(reason);
    } finally {
        busy.value = '';
    }
}

async function loadAccount(): Promise<void> {
    account.value = await api<Account>('GET', '/api/account');
}

async function loadWorkspaces(): Promise<void> {
    workspaceState.value = await api<WorkspaceState>('GET', '/api/workspaces');
}

async function loadPages(): Promise<void> {
    pages.value = await api<Page[]>('GET', '/api/pages');
}

async function signIn(): Promise<void> {
    await run('Starting sign in…', async () => {
        // The core opens the approval page in the browser
        await api('POST', '/api/account/connect', {
            device_name: 'Yeidle on Android',
        });
        signingIn.value = true;
        approvalPoll = setInterval(() => void checkApproval(), 3000);
    });
}

let checkingApproval = false;

async function checkApproval(): Promise<void> {
    // One check at a time: an overlapping one would find the request
    // already completed
    if (checkingApproval || !signingIn.value) {
        return;
    }

    checkingApproval = true;

    try {
        const result = await api<{ status: string }>(
            'POST',
            '/api/account/complete',
        );

        if (result.status === 'pending') {
            return;
        }

        stopApprovalPoll();
        // The approval page has nothing more to do: bring the app back
        closeBrowser();

        if (result.status === 'expired') {
            error.value = 'The sign-in request expired. Try again.';

            return;
        }

        await Promise.all([loadAccount(), loadWorkspaces()]);
    } catch (reason) {
        stopApprovalPoll();
        error.value = reason instanceof Error ? reason.message : String(reason);
    } finally {
        checkingApproval = false;
    }
}

function stopApprovalPoll(): void {
    signingIn.value = false;

    if (approvalPoll !== null) {
        clearInterval(approvalPoll);
        approvalPoll = null;
    }
}

async function cancelSignIn(): Promise<void> {
    stopApprovalPoll();
    await api('DELETE', '/api/account/connect').catch(() => undefined);
}

async function chooseWorkspace(workspace: Workspace): Promise<void> {
    await run(`Opening ${workspace.name}…`, async () => {
        await api('POST', `/api/workspaces/${workspace.id}/activate`);

        if (workspace.cloud_status !== 'local') {
            busy.value = `Downloading ${workspace.name}…`;
            await api('POST', '/api/account/sync-active-workspace');
        }

        await Promise.all([loadWorkspaces(), loadPages()]);
        openPage.value = null;
    });
}

async function showPage(id: string): Promise<void> {
    await run('Opening page…', async () => {
        const page = await api<{
            id: string;
            text: string;
            children: BlockTree[];
        }>('GET', `/api/blocks/${id}`);
        openPage.value = {
            id: page.id,
            title: page.text,
            blocks: page.children,
        };
    });
}

let searchRequest = 0;

watch(query, async (value) => {
    const request = ++searchRequest;

    if (value.trim() === '') {
        results.value = [];

        return;
    }

    const found = await api<SearchResult[]>(
        'GET',
        `/api/search?q=${encodeURIComponent(value)}`,
    ).catch(() => []);

    if (request === searchRequest) {
        results.value = found;
    }
});

const stopListening = onDocumentsChanged((documentIds) => {
    void loadPages();

    if (openPage.value && documentIds.includes(openPage.value.id)) {
        void showPage(openPage.value.id);
    }
});

onMounted(async () => {
    try {
        await coreReady;
        await Promise.all([loadAccount(), loadWorkspaces(), loadPages()]);
        status.value = 'ready';
    } catch (reason) {
        startError.value =
            reason instanceof Error ? reason.message : String(reason);
        status.value = 'failed';
    }
});

onBeforeUnmount(() => {
    stopListening();
    stopApprovalPoll();
});
</script>

<template>
    <main>
        <p v-if="status === 'starting'" class="muted center">
            Starting Yeidle…
        </p>
        <p v-else-if="status === 'failed'" class="error center">
            Yeidle couldn't start: {{ startError }}
        </p>

        <template v-else-if="openPage">
            <header>
                <button class="link" @click="openPage = null">‹ Pages</button>
            </header>
            <h1>{{ openPage.title || '[untitled]' }}</h1>
            <ul v-if="openPage.blocks.length" class="outline">
                <BlockItem
                    v-for="block in openPage.blocks"
                    :key="block.id"
                    :block="block"
                />
            </ul>
            <p v-else class="muted">This page is empty.</p>
        </template>

        <template v-else>
            <header>
                <h1>{{ activeWorkspace?.name ?? 'Yeidle' }}</h1>
                <span class="muted">{{
                    account?.signed_in ? account.user?.email : 'Offline'
                }}</span>
            </header>

            <section v-if="!account?.signed_in" class="card">
                <template v-if="signingIn">
                    <p>
                        Approve this device in the browser. This screen updates
                        by itself.
                    </p>
                    <button class="link" @click="cancelSignIn">Cancel</button>
                </template>
                <button v-else @click="signIn">Sign in to Yeidle Cloud</button>
            </section>

            <section
                v-if="(workspaceState?.workspaces.length ?? 0) > 1"
                class="workspaces"
            >
                <button
                    v-for="workspace in workspaceState!.workspaces"
                    :key="workspace.id"
                    :class="{
                        active:
                            workspace.id ===
                            workspaceState!.active_workspace_id,
                    }"
                    @click="chooseWorkspace(workspace)"
                >
                    {{ workspace.name }}
                    <small v-if="workspace.cloud_status !== 'local'"
                        >cloud</small
                    >
                </button>
            </section>

            <input
                v-model="query"
                type="search"
                placeholder="Search pages and blocks"
            />

            <ul v-if="query.trim() !== ''" class="list">
                <li v-for="result in results" :key="result.id">
                    <button @click="showPage(result.page_id)">
                        <span :class="{ muted: result.kind === 'block' }">{{
                            result.text || '[untitled]'
                        }}</span>
                    </button>
                </li>
                <li v-if="results.length === 0" class="muted">No matches.</li>
            </ul>
            <ul v-else class="list">
                <li v-for="page in pages" :key="page.id">
                    <button @click="showPage(page.id)">
                        {{ page.title || '[untitled]' }}
                    </button>
                </li>
                <li v-if="pages.length === 0" class="muted">No pages yet.</li>
            </ul>
        </template>

        <p v-if="busy" class="toast">{{ busy }}</p>
        <p v-if="error" class="error">{{ error }}</p>
    </main>
</template>

<style>
:root {
    --bg: #ffffff;
    --fg: #1d1d1f;
    --muted: #6e6e73;
    --line: #e5e5ea;
    --accent: #2f6fde;
    --danger: #c62828;
    color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
    :root {
        --bg: #14181f;
        --fg: #e8eaed;
        --muted: #9aa0a6;
        --line: #2a303a;
        --accent: #7aa7ff;
        --danger: #ff8a80;
    }
}

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font:
        16px/1.5 system-ui,
        sans-serif;
}

main {
    padding: max(16px, env(safe-area-inset-top)) 16px 96px;
    max-width: 720px;
    margin: 0 auto;
}

header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
}

h1 {
    font-size: 1.5rem;
    margin: 8px 0 16px;
}

button {
    font: inherit;
    color: inherit;
    background: none;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    text-align: left;
}

button.link {
    border: none;
    padding: 8px 0;
    color: var(--accent);
}

input[type='search'] {
    width: 100%;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 8px 0;
}

.card {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 12px;
}

.card > button:not(.link) {
    width: 100%;
    background: var(--accent);
    color: var(--bg);
    border: none;
}

.workspaces {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 4px;
}

.workspaces button {
    white-space: nowrap;
}

.workspaces button.active {
    border-color: var(--accent);
}

.list {
    list-style: none;
    padding: 0;
    margin: 0;
}

.list button {
    width: 100%;
    border: none;
    border-bottom: 1px solid var(--line);
    border-radius: 0;
}

.outline,
.outline ul {
    padding-left: 1.25rem;
}

.outline li {
    margin: 4px 0;
    overflow-wrap: anywhere;
}

.muted {
    color: var(--muted);
}

.center {
    text-align: center;
    margin-top: 40vh;
}

.error {
    color: var(--danger);
}

.toast {
    position: fixed;
    left: 16px;
    right: 16px;
    bottom: max(16px, env(safe-area-inset-bottom));
    background: var(--fg);
    color: var(--bg);
    border-radius: 10px;
    padding: 12px 14px;
    margin: 0;
}
</style>
