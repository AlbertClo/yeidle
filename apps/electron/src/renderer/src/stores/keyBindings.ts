import { ref } from 'vue';
import {
    DEFAULT_KEY_BINDINGS,
    eventMatchesKeyBinding,
    formatKeyBinding,
    KEY_BINDING_DEFINITIONS,
} from '../types/keyBindings';
import type { KeyBindingCommand, KeyBindings } from '../types/keyBindings';
import { keyboardPlatform } from '../types/keyboardPlatform';
import { KeySequenceMatcher } from '../types/keySequences';
import { hasOpenModal } from '../ui/modal';

export const keyBindings = ref<KeyBindings>({ ...DEFAULT_KEY_BINDINGS });
const sequences = new KeySequenceMatcher();
const eventCommands = new WeakMap<KeyboardEvent, Set<KeyBindingCommand>>();

export function resetKeySequence(): void {
    sequences.reset();
}

export function prepareShortcutEvent(event: KeyboardEvent): boolean {
    if (hasOpenModal()) {
        sequences.reset();
        eventCommands.set(event, new Set());

        return false;
    }

    const target = event.target;
    const editing =
        typeof Element !== 'undefined' &&
        target instanceof Element &&
        Boolean(
            target.closest(
                'input, textarea, select, [contenteditable="true"], [role="textbox"]',
            ),
        );
    const result = sequences.match(event, keyBindings.value, editing);
    eventCommands.set(event, result.commands);

    return result.prefix;
}

let loaded = false;
let loadRequest: Promise<void> | null = null;

type KeyBindingResponse = {
    bindings: KeyBindings;
    defaults: Record<KeyBindingCommand, string>;
};

function normalizeBindings(value: unknown): KeyBindings {
    if (typeof value !== 'object' || value === null) {
        throw new Error('The saved keyboard shortcuts are invalid.');
    }

    const candidate = value as Record<string, unknown>;
    const normalized = { ...DEFAULT_KEY_BINDINGS };

    for (const definition of KEY_BINDING_DEFINITIONS) {
        const binding = candidate[definition.id];

        if (binding !== null && typeof binding !== 'string') {
            throw new Error('The saved keyboard shortcuts are invalid.');
        }

        normalized[definition.id] = binding;
    }

    return normalized;
}

export async function loadKeyBindings(force = false): Promise<void> {
    if (loadRequest !== null) {
        await loadRequest;

        if (force) {
            return loadKeyBindings(true);
        }

        return;
    }

    if (loaded && !force) {
        return;
    }

    loadRequest = fetch('/api/key-bindings', {
        headers: {
            Accept: 'application/json',
            'X-Yeidle-Keyboard-Platform': keyboardPlatform(),
        },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load keyboard shortcuts.');
            }

            const payload = (await response.json()) as KeyBindingResponse;
            keyBindings.value = normalizeBindings(payload.bindings);
            sequences.reset();
            loaded = true;
        })
        .finally(() => {
            loadRequest = null;
        });

    return loadRequest;
}

export async function saveKeyBindings(bindings: KeyBindings): Promise<void> {
    const response = await fetch('/api/key-bindings', {
        method: 'PUT',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Yeidle-Keyboard-Platform': keyboardPlatform(),
        },
        body: JSON.stringify({ bindings }),
    });

    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
            message?: string;
        } | null;

        throw new Error(
            payload?.message ?? 'Could not save keyboard shortcuts.',
        );
    }

    const payload = (await response.json()) as KeyBindingResponse;
    keyBindings.value = normalizeBindings(payload.bindings);
    sequences.reset();
    loaded = true;
}

export function bindingFor(command: KeyBindingCommand): string | null {
    return keyBindings.value[command];
}

/**
 * Whether this device has keyboard shortcuts: not on touch-only devices
 * (phones), where shortcut hints and settings are hidden.
 */
export const keyboardShortcutsAvailable = !globalThis.matchMedia?.(
    '(hover: none) and (pointer: coarse)',
).matches;

/** The command's shortcut for display; empty where there are no shortcuts. */
export function bindingLabel(command: KeyBindingCommand): string {
    return keyboardShortcutsAvailable
        ? formatKeyBinding(bindingFor(command))
        : '';
}

/** A tooltip with the command's shortcut when there is one: `Back (Alt+←)`. */
export function withShortcut(
    label: string,
    command: KeyBindingCommand,
): string {
    const shortcut = bindingLabel(command);

    return shortcut ? `${label} (${shortcut})` : label;
}

export function eventMatchesCommand(
    event: KeyboardEvent,
    command: KeyBindingCommand,
): boolean {
    if (hasOpenModal()) {
        return false;
    }

    const prepared = eventCommands.get(event);

    return prepared
        ? prepared.has(command)
        : eventMatchesKeyBinding(event, bindingFor(command));
}
