<script setup lang="ts">
import { Check, Minus, Plus } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { applyTypography } from '@/composables/useTypography';
import {
    fontFamilyPreference,
    fontSizePreference,
    saveTypographyPreference,
} from '@/stores/preferences';
import {
    FONT_OPTIONS,
    MAX_FONT_SIZE,
    MIN_FONT_SIZE,
    fontFamilyValue,
} from '@/types';
import type { FontFamily } from '@/types';
import { OPEN_TYPOGRAPHY_SELECTOR_EVENT } from '@/ui/typographySelector';

const isOpen = ref(false);
const saving = ref(false);
const draftFontFamily = ref<FontFamily>(fontFamilyPreference.value);
const draftFontSize = ref(fontSizePreference.value);
const previewFontFamily = computed(() =>
    fontFamilyValue(draftFontFamily.value),
);

function openDialog(): void {
    draftFontFamily.value = fontFamilyPreference.value;
    draftFontSize.value = fontSizePreference.value;
    isOpen.value = true;
}

async function save(fontFamily: FontFamily, fontSize: number): Promise<void> {
    if (saving.value) {
        return;
    }

    saving.value = true;

    try {
        await saveTypographyPreference(fontFamily, fontSize);
    } catch {
        draftFontFamily.value = fontFamilyPreference.value;
        draftFontSize.value = fontSizePreference.value;
        toast.error('Could not save the font preference.');
    } finally {
        saving.value = false;
    }
}

function selectFont(fontFamily: FontFamily): void {
    if (saving.value || draftFontFamily.value === fontFamily) {
        return;
    }

    draftFontFamily.value = fontFamily;
    applyTypography(fontFamily, draftFontSize.value);
    void save(fontFamily, draftFontSize.value);
}

function previewSize(event: Event): void {
    const fontSize = Number((event.target as HTMLInputElement).value);

    draftFontSize.value = fontSize;
    applyTypography(draftFontFamily.value, fontSize);
}

function saveSize(): void {
    if (draftFontSize.value === fontSizePreference.value) {
        return;
    }

    void save(draftFontFamily.value, draftFontSize.value);
}

function adjustSize(amount: number): void {
    if (saving.value) {
        return;
    }

    const fontSize = Math.min(
        MAX_FONT_SIZE,
        Math.max(MIN_FONT_SIZE, draftFontSize.value + amount),
    );

    if (fontSize === draftFontSize.value) {
        return;
    }

    draftFontSize.value = fontSize;
    applyTypography(draftFontFamily.value, fontSize);
    void save(draftFontFamily.value, fontSize);
}

watch(isOpen, (open) => {
    if (!open) {
        applyTypography(fontFamilyPreference.value, fontSizePreference.value);
    }
});

onMounted(() => {
    window.addEventListener(OPEN_TYPOGRAPHY_SELECTOR_EVENT, openDialog);
});

onBeforeUnmount(() => {
    window.removeEventListener(OPEN_TYPOGRAPHY_SELECTOR_EVENT, openDialog);
});
</script>

<template>
    <Dialog v-model:open="isOpen">
        <DialogContent class="sm:max-w-4xl">
            <div
                class="grid gap-6 md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
            >
                <div>
                    <DialogHeader class="mb-5">
                        <DialogTitle>Choose a font</DialogTitle>
                        <DialogDescription>
                            Select the typeface and text size used by Yeidle.
                        </DialogDescription>
                    </DialogHeader>

                    <div class="grid grid-cols-2 gap-3">
                        <button
                            v-for="font in FONT_OPTIONS"
                            :key="font.value"
                            type="button"
                            :aria-pressed="draftFontFamily === font.value"
                            :disabled="saving"
                            class="relative min-h-20 cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                            :class="
                                draftFontFamily === font.value
                                    ? 'border-ring ring-1 ring-ring'
                                    : 'border-border'
                            "
                            :style="{ fontFamily: font.family }"
                            @click="selectFont(font.value)"
                        >
                            <div class="mb-1 text-xl">Aa</div>
                            <div class="pr-5 text-sm font-medium">
                                {{ font.label }}
                            </div>
                            <Check
                                v-if="draftFontFamily === font.value"
                                class="absolute right-3 bottom-3 size-4"
                            />
                        </button>
                    </div>

                    <div class="mt-6">
                        <div class="mb-3 flex items-center justify-between">
                            <span class="text-sm font-medium">Font size</span>
                            <span
                                class="text-sm text-muted-foreground tabular-nums"
                                >{{ draftFontSize }} px</span
                            >
                        </div>
                        <div class="flex items-center gap-3">
                            <button
                                type="button"
                                aria-label="Decrease font size"
                                :disabled="
                                    saving || draftFontSize <= MIN_FONT_SIZE
                                "
                                class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40"
                                @click="adjustSize(-1)"
                            >
                                <Minus class="size-4" />
                            </button>
                            <input
                                :value="draftFontSize"
                                type="range"
                                :min="MIN_FONT_SIZE"
                                :max="MAX_FONT_SIZE"
                                step="1"
                                :disabled="saving"
                                aria-label="Font size"
                                class="h-2 min-w-0 flex-1 cursor-pointer accent-primary disabled:cursor-default"
                                @input="previewSize"
                                @change="saveSize"
                            />
                            <button
                                type="button"
                                aria-label="Increase font size"
                                :disabled="
                                    saving || draftFontSize >= MAX_FONT_SIZE
                                "
                                class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-40"
                                @click="adjustSize(1)"
                            >
                                <Plus class="size-4" />
                            </button>
                        </div>
                    </div>
                </div>

                <section
                    aria-label="Typography preview"
                    class="min-h-96 overflow-hidden rounded-lg border bg-background shadow-sm"
                    :style="{ fontFamily: previewFontFamily }"
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
                        <span class="text-foreground">Typography preview</span>
                    </div>

                    <div class="px-8 py-7">
                        <p
                            class="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                        >
                            Page preview
                        </p>
                        <h2 class="mb-6 text-2xl font-semibold">
                            Typography preview
                        </h2>

                        <div class="space-y-3">
                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                />
                                <span
                                    >Write clearly and keep ideas
                                    connected</span
                                >
                            </div>
                            <div class="flex items-start gap-3">
                                <span
                                    class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                />
                                <span>
                                    Link this note to
                                    <span :style="{ color: 'var(--link)' }"
                                        >[[Typography]]</span
                                    >
                                </span>
                            </div>
                            <div class="ml-0.5 border-l pl-7">
                                <div class="flex items-start gap-3">
                                    <span
                                        class="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground"
                                    />
                                    <span class="text-muted-foreground">
                                        Comfortable text makes long sessions
                                        easier
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>
                </section>
            </div>
        </DialogContent>
    </Dialog>
</template>
