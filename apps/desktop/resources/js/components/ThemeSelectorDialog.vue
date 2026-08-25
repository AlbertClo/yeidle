<script setup lang="ts">
import { Check } from 'lucide-vue-next';
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { toast } from 'vue-sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    loadPreferences,
    opsAffectPreferences,
    saveThemePreference,
    themePreference,
} from '@/stores/preferences';
import { LOCAL_OPS_AVAILABLE_EVENT } from '@/sync/localOps';
import type { LocalOpsAvailableEvent } from '@/sync/localOps';
import { THEME_OPTIONS } from '@/types';
import type { Theme } from '@/types';
import { OPEN_THEME_SELECTOR_EVENT } from '@/ui/themeSelector';

const isOpen = ref(false);
const saving = ref(false);

function openDialog(): void {
    isOpen.value = true;
}

async function selectTheme(theme: Theme): Promise<void> {
    if (saving.value || themePreference.value === theme) {
        return;
    }

    saving.value = true;

    try {
        await saveThemePreference(theme);
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
        <DialogContent class="max-h-[85svh] overflow-y-auto sm:max-w-4xl">
            <div
                class="grid gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]"
            >
                <div>
                    <DialogHeader class="mb-4">
                        <DialogTitle>Choose a theme</DialogTitle>
                        <DialogDescription>
                            Select how Yeidle looks in this workspace.
                        </DialogDescription>
                    </DialogHeader>

                    <div class="grid grid-cols-2 gap-3">
                        <button
                            v-for="theme in THEME_OPTIONS"
                            :key="theme.value"
                            type="button"
                            :aria-pressed="themePreference === theme.value"
                            :disabled="saving"
                            class="relative cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                            :class="
                                themePreference === theme.value
                                    ? 'border-ring ring-1 ring-ring'
                                    : 'border-border'
                            "
                            @click="selectTheme(theme.value)"
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
                            <div class="pr-5 text-sm font-medium">
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
                    class="min-h-96 overflow-hidden rounded-lg border bg-background shadow-sm"
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

                    <div class="px-8 py-7">
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
                </section>
            </div>
        </DialogContent>
    </Dialog>
</template>
