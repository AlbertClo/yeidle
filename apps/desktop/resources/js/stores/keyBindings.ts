import { ref } from 'vue';
import {
    DEFAULT_KEY_BINDINGS,
    eventMatchesKeyBinding,
    formatKeyBinding,
    KEY_BINDING_DEFINITIONS,
} from '../types/keyBindings';
import type { KeyBindingCommand, KeyBindings } from '../types/keyBindings';
import { hasOpenModal } from '../ui/modal';

export const keyBindings = ref<KeyBindings>({ ...DEFAULT_KEY_BINDINGS });

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
        headers: { Accept: 'application/json' },
    })
        .then(async (response) => {
            if (!response.ok) {
                throw new Error('Could not load keyboard shortcuts.');
            }

            const payload = (await response.json()) as KeyBindingResponse;
            keyBindings.value = normalizeBindings(payload.bindings);
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
    loaded = true;
}

export function bindingFor(command: KeyBindingCommand): string | null {
    return keyBindings.value[command];
}

export function bindingLabel(command: KeyBindingCommand): string {
    return formatKeyBinding(bindingFor(command));
}

export function eventMatchesCommand(
    event: KeyboardEvent,
    command: KeyBindingCommand,
): boolean {
    if (hasOpenModal()) {
        return false;
    }

    return eventMatchesKeyBinding(event, bindingFor(command));
}
