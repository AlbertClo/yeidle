<script setup lang="ts">
import { Check } from 'lucide-vue-next';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    loadPreferences,
    hasSavedThemePreference,
    opsAffectPreferences,
    saveThemePreference,
    themePreference,
} from '@/stores/preferences';
import { LOCAL_OPS_AVAILABLE_EVENT } from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';
import { THEME_OPTIONS } from '@/types';
import type { Theme } from '@/types';
import {
    notifyThemeSelected,
    OPEN_THEME_SELECTOR_EVENT,
} from '@/ui/themeSelector';

const isOpen = ref(false);
const saving = ref(false);
const selectedIndex = ref<number | null>(null);
const lastThemeIndex = ref(0);
const themeButtonRefs = ref<(HTMLButtonElement | null)[]>([]);

function openDialog(): void {
    isOpen.value = true;
}

function setThemeButtonRef(index: number, element: unknown): void {
    themeButtonRefs.value[index] =
        element instanceof HTMLButtonElement ? element : null;
}

function focusTheme(index: number, focus = true): void {
    const nextIndex = Math.max(0, Math.min(index, THEME_OPTIONS.length - 1));
    selectedIndex.value = nextIndex;
    lastThemeIndex.value = nextIndex;

    if (!focus) {
        return;
    }

    void nextTick(() => {
        const button = themeButtonRefs.value[nextIndex];
        button?.focus({ preventScroll: true });
        button?.scrollIntoView({ block: 'nearest' });
    });
}

function focusCloseButton(): void {
    selectedIndex.value = null;
    document
        .querySelector<HTMLButtonElement>('[data-theme-close="true"]')
        ?.focus({ preventScroll: true });
}

function handleThemeKeydown(event: KeyboardEvent, index: number): void {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
    }

    let targetIndex: number | null = null;

    if (event.key === 'ArrowLeft' && index > 0) {
        targetIndex = index - 1;
    } else if (event.key === 'ArrowRight' && index < THEME_OPTIONS.length - 1) {
        targetIndex = index + 1;
    } else if (event.key === 'ArrowUp' && index >= 3) {
        targetIndex = index - 3;
    } else if (event.key === 'ArrowDown') {
        if (index + 3 < THEME_OPTIONS.length) {
            targetIndex = index + 3;
        } else {
            event.preventDefault();
            event.stopPropagation();
            focusCloseButton();

            return;
        }
    } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void selectTheme(THEME_OPTIONS[index].value);

        return;
    }

    if (targetIndex === null) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusTheme(targetIndex);
}

function handleCloseKeydown(event: KeyboardEvent): void {
    if (
        event.key !== 'ArrowUp' ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
    ) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusTheme(lastThemeIndex.value);
}

function handleOpenAutoFocus(event: Event): void {
    event.preventDefault();
    const currentIndex = THEME_OPTIONS.findIndex(
        ({ value }) => value === themePreference.value,
    );
    focusTheme(currentIndex < 0 ? 0 : currentIndex);
}

async function selectTheme(theme: Theme): Promise<void> {
    if (
        saving.value ||
        (hasSavedThemePreference.value && themePreference.value === theme)
    ) {
        return;
    }

    saving.value = true;

    try {
        await saveThemePreference(theme);
        notifyThemeSelected();
    } catch {
        toast.error('Could not save the theme.');
    } finally {
        saving.value = false;
    }
}

function handleLocalOps(event: Event): void {
    const detail = (event as LocalOpsAvailableEvent).detail;

    if (opsAffectPreferences(detail?.ops ?? null)) {
        void loadPreferences(true);
    }
}

watch(isOpen, (open) => {
    if (!open) {
        selectedIndex.value = null;
    }
});

onMounted(() => {
    void loadPreferences(true);
    window.addEventListener(OPEN_THEME_SELECTOR_EVENT, openDialog);
    window.addEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOps);
});

onBeforeUnmount(() => {
    window.removeEventListener(OPEN_THEME_SELECTOR_EVENT, openDialog);
    window.removeEventListener(LOCAL_OPS_AVAILABLE_EVENT, handleLocalOps);
});
</script>

<template>
    <Dialog v-model:open="isOpen">
        <DialogContent
            class="max-h-[85svh] overflow-y-auto sm:max-w-5xl"
            @open-auto-focus="handleOpenAutoFocus"
        >
            <div
                class="grid gap-6 md:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]"
            >
                <div>
                    <DialogHeader class="mb-4">
                        <DialogTitle>Choose a theme</DialogTitle>
                        <DialogDescription>
                            Select how Yeidle looks in this workspace.
                        </DialogDescription>
                    </DialogHeader>

                    <div class="grid grid-cols-3 gap-3">
                        <button
                            v-for="(theme, index) in THEME_OPTIONS"
                            :key="theme.value"
                            :ref="
                                (element) => setThemeButtonRef(index, element)
                            "
                            type="button"
                            :aria-pressed="themePreference === theme.value"
                            :aria-busy="saving"
                            class="relative flex cursor-pointer flex-col items-stretch justify-start rounded-lg border p-3 text-left outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            :class="[
                                themePreference === theme.value
                                    ? 'border-ring ring-1 ring-ring'
                                    : 'border-border',
                                selectedIndex === index
                                    ? 'bg-accent'
                                    : undefined,
                            ]"
                            @click="selectTheme(theme.value)"
                            @focus="focusTheme(index, false)"
                            @mouseenter="focusTheme(index, false)"
                            @keydown="handleThemeKeydown($event, index)"
                        >
                            <div
                                class="mb-3 flex h-10 overflow-hidden rounded-md border border-black/10 dark:border-white/10"
                            >
                                <span
                                    v-for="color in theme.preview"
                                    :key="color"
                                    class="h-full flex-1"
                                    :style="{ backgroundColor: color }"
                                />
                            </div>
                            <div class="pr-5 text-xs font-medium">
                                {{ theme.label }}
                            </div>
                            <Check
                                v-if="themePreference === theme.value"
                                class="absolute right-3 bottom-3 size-4"
                            />
                        </button>
                    </div>
                </div>

                <section
                    aria-label="Theme preview"
                    class="relative min-h-96 overflow-hidden rounded-lg border bg-background shadow-sm"
                >
                    <div
                        class="flex h-11 items-center gap-2 border-b px-4 text-sm text-muted-foreground"
                    >
                        <span
                            class="flex size-5 items-center justify-center rounded border text-xs"
                            >‹</span
                        >
                        <span>All Pages</span>
                        <span class="text-muted-foreground/60">›</span>
                        <span class="text-foreground">Theme preview</span>
                    </div>

                    <div class="px-8 pt-7 pb-20">
                        <p
                            class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                        >
                            Page preview
                        </p>
                        <h2 class="mb-6 text-2xl font-semibold">
                            Theme preview
                        </h2>

                        <div class="space-y-2.5 text-sm">
                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs border bg-primary text-primary-foreground"
                                >
                                    <Check class="size-3" />
                                </span>
                                <span class="text-muted-foreground line-through"
                                    >Select a theme</span
                                >
                            </div>

                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-0.5 size-4 shrink-0 rounded-xs border"
                                />
                                <span>Close this window</span>
                            </div>

                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                />
                                <span>
                                    Share the announcement with
                                    <span :style="{ color: 'var(--link)' }"
                                        >[[Marketing]]</span
                                    >
                                </span>
                            </div>

                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                />
                                <span>Notes from the launch meeting</span>
                            </div>

                            <div class="ml-0.5 border-l pl-7">
                                <div class="flex items-start gap-3">
                                    <span
                                        class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                    />
                                    <span class="text-muted-foreground"
                                        >Publish Tuesday at 09:00</span
                                    >
                                </div>
                            </div>
                        </div>
                    </div>

                    <Button
                        type="button"
                        variant="outline"
                        class="absolute right-4 bottom-4"
                        :aria-busy="saving"
                        data-theme-close="true"
                        @click="isOpen = false"
                        @keydown="handleCloseKeydown"
                    >
                        Close
                    </Button>
                </section>
            </div>
        </DialogContent>
    </Dialog>
</template>
