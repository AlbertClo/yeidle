<script setup lang="ts">
import { RotateCcw } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
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
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    keyBindings,
    loadKeyBindings,
    saveKeyBindings,
} from '@/stores/keyBindings';
import {
    DEFAULT_KEY_BINDINGS,
    formatKeyBinding,
    KEY_BINDING_DEFINITIONS,
    keyBindingFromEvent,
} from '@/types/keyBindings';
import type { KeyBindingCommand, KeyBindings } from '@/types/keyBindings';
import { OPEN_KEY_BINDINGS_EVENT } from '@/ui/keyBindings';

const isOpen = ref(false);
const draft = ref<KeyBindings>({ ...DEFAULT_KEY_BINDINGS });
const recording = ref<KeyBindingCommand | null>(null);
const captureError = ref<string | null>(null);
const saveError = ref<string | null>(null);
const saving = ref(false);
const draftTouched = ref(false);

const conflicts = computed(() => {
    const commandsByBinding = new Map<string, KeyBindingCommand[]>();

    for (const definition of KEY_BINDING_DEFINITIONS) {
        const binding = draft.value[definition.id];

        if (binding === null) {
            continue;
        }

        const commands = commandsByBinding.get(binding) ?? [];
        commands.push(definition.id);
        commandsByBinding.set(binding, commands);
    }

    return new Set(
        [...commandsByBinding.values()]
            .filter((commands) => commands.length > 1)
            .flat(),
    );
});

const hasChanges = computed(() =>
    KEY_BINDING_DEFINITIONS.some(
        ({ id }) => draft.value[id] !== keyBindings.value[id],
    ),
);

function openDialog(): void {
    isOpen.value = true;
}

function beginRecording(command: KeyBindingCommand): void {
    recording.value = command;
    captureError.value = null;
    saveError.value = null;
}

function captureBinding(
    event: KeyboardEvent,
    command: KeyBindingCommand,
): void {
    if (recording.value !== command) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
        recording.value = null;
        captureError.value = null;

        return;
    }

    if (
        (event.key === 'Backspace' || event.key === 'Delete') &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
    ) {
        draft.value[command] = null;
        draftTouched.value = true;
        recording.value = null;
        captureError.value = null;

        return;
    }

    const binding = keyBindingFromEvent(event);

    if (binding === null) {
        if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
            captureError.value =
                'Use Ctrl, Alt, or a function key in the shortcut.';
        }

        return;
    }

    draft.value[command] = binding;
    draftTouched.value = true;
    recording.value = null;
    captureError.value = null;
}

function clearBinding(command: KeyBindingCommand): void {
    draft.value[command] = null;
    draftTouched.value = true;
    recording.value = null;
    captureError.value = null;
    saveError.value = null;
}

function resetBinding(command: KeyBindingCommand): void {
    draft.value[command] = DEFAULT_KEY_BINDINGS[command];
    draftTouched.value = true;
    recording.value = null;
    captureError.value = null;
    saveError.value = null;
}

function resetAll(): void {
    draft.value = { ...DEFAULT_KEY_BINDINGS };
    draftTouched.value = true;
    recording.value = null;
    captureError.value = null;
    saveError.value = null;
}

async function save(): Promise<void> {
    if (saving.value || conflicts.value.size > 0) {
        return;
    }

    saving.value = true;
    saveError.value = null;

    try {
        await saveKeyBindings({ ...draft.value });
        isOpen.value = false;
    } catch (error) {
        saveError.value =
            error instanceof Error
                ? error.message
                : 'Could not save keyboard shortcuts.';
    } finally {
        saving.value = false;
    }
}

watch(isOpen, (open) => {
    if (!open) {
        recording.value = null;
        captureError.value = null;
        saveError.value = null;

        return;
    }

    draft.value = { ...keyBindings.value };
    draftTouched.value = false;
    void loadKeyBindings()
        .then(() => {
            if (isOpen.value && !draftTouched.value) {
                draft.value = { ...keyBindings.value };
            }
        })
        .catch((error) => {
            saveError.value =
                error instanceof Error
                    ? error.message
                    : 'Could not load keyboard shortcuts.';
        });
});

onMounted(() => {
    window.addEventListener(OPEN_KEY_BINDINGS_EVENT, openDialog);
});

onBeforeUnmount(() => {
    window.removeEventListener(OPEN_KEY_BINDINGS_EVENT, openDialog);
});
</script>

<template>
    <TooltipProvider :delay-duration="300">
        <Dialog v-model:open="isOpen">
            <DialogContent class="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>
                        These shortcuts apply to your account on this device
                        across all workspaces.
                    </DialogDescription>
                </DialogHeader>

                <div class="max-h-[60svh] space-y-1 overflow-y-auto py-2">
                    <div
                        v-for="definition in KEY_BINDING_DEFINITIONS"
                        :key="definition.id"
                        class="grid grid-cols-[minmax(0,1fr)_11rem_auto_auto] items-center gap-2 rounded-md px-2 py-2"
                        :class="
                            conflicts.has(definition.id)
                                ? 'bg-destructive/10'
                                : 'hover:bg-muted/50'
                        "
                    >
                        <div class="min-w-0">
                            <p class="truncate text-sm font-medium">
                                {{ definition.label }}
                            </p>
                            <p
                                v-if="conflicts.has(definition.id)"
                                class="text-xs text-destructive"
                            >
                                Conflicts with another shortcut
                            </p>
                        </div>

                        <button
                            type="button"
                            class="flex h-9 cursor-pointer items-center justify-center rounded-md border bg-background px-3 text-sm transition-colors outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                            :class="
                                recording === definition.id
                                    ? 'border-ring ring-[3px] ring-ring/50'
                                    : undefined
                            "
                            :aria-label="`Change ${definition.label} shortcut. Current shortcut: ${formatKeyBinding(draft[definition.id])}`"
                            @click="beginRecording(definition.id)"
                            @keydown="captureBinding($event, definition.id)"
                        >
                            <span v-if="recording === definition.id">
                                Press shortcut…
                            </span>
                            <kbd v-else-if="draft[definition.id] !== null">
                                {{ formatKeyBinding(draft[definition.id]) }}
                            </kbd>
                            <span v-else class="text-muted-foreground">
                                Unassigned
                            </span>
                        </button>

                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            :disabled="draft[definition.id] === null"
                            @click="clearBinding(definition.id)"
                        >
                            Clear
                        </Button>

                        <Tooltip>
                            <TooltipTrigger as-child>
                                <span class="inline-flex">
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        :disabled="
                                            draft[definition.id] ===
                                            DEFAULT_KEY_BINDINGS[definition.id]
                                        "
                                        :aria-label="`Reset ${definition.label} to ${formatKeyBinding(DEFAULT_KEY_BINDINGS[definition.id])}`"
                                        @click="resetBinding(definition.id)"
                                    >
                                        <RotateCcw class="h-4 w-4" />
                                    </Button>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="top">
                                Reset to
                                {{
                                    formatKeyBinding(
                                        DEFAULT_KEY_BINDINGS[definition.id],
                                    )
                                }}
                            </TooltipContent>
                        </Tooltip>
                    </div>
                </div>

                <p v-if="captureError" class="text-sm text-destructive">
                    {{ captureError }}
                </p>
                <p v-if="saveError" class="text-sm text-destructive">
                    {{ saveError }}
                </p>

                <DialogFooter class="sm:justify-between">
                    <Button type="button" variant="ghost" @click="resetAll">
                        Reset all
                    </Button>
                    <div class="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            @click="isOpen = false"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="button"
                            :disabled="
                                saving ||
                                recording !== null ||
                                conflicts.size > 0 ||
                                !hasChanges
                            "
                            @click="save"
                        >
                            {{ saving ? 'Saving…' : 'Save shortcuts' }}
                        </Button>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    </TooltipProvider>
</template>
