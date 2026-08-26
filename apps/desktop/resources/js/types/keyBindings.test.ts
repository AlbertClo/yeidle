import { describe, expect, it } from 'vitest';
import {
    DEFAULT_KEY_BINDINGS,
    eventMatchesKeyBinding,
    formatKeyBinding,
    keyBindingFromEvent,
    PINNED_ITEM_COMMANDS,
} from './keyBindings';

function keyboardEvent(
    key: string,
    modifiers: Partial<KeyboardEvent> = {},
): KeyboardEvent {
    return {
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        shiftKey: false,
        ...modifiers,
    } as KeyboardEvent;
}

describe('key bindings', () => {
    it('normalizes control and command to Mod', () => {
        expect(keyBindingFromEvent(keyboardEvent('k', { ctrlKey: true }))).toBe(
            'Mod+K',
        );
        expect(keyBindingFromEvent(keyboardEvent('k', { metaKey: true }))).toBe(
            'Mod+K',
        );
    });

    it('normalizes named, shifted, and punctuation keys', () => {
        expect(
            keyBindingFromEvent(keyboardEvent('ArrowLeft', { altKey: true })),
        ).toBe('Alt+ArrowLeft');
        expect(
            keyBindingFromEvent(
                keyboardEvent('P', { ctrlKey: true, shiftKey: true }),
            ),
        ).toBe('Mod+Shift+P');
        expect(keyBindingFromEvent(keyboardEvent('/', { ctrlKey: true }))).toBe(
            'Mod+Slash',
        );
    });

    it('rejects unmodified typing keys and matches exact modifiers', () => {
        expect(keyBindingFromEvent(keyboardEvent('a'))).toBeNull();
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('k', { ctrlKey: true }),
                'Mod+K',
            ),
        ).toBe(true);
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('k', { ctrlKey: true, shiftKey: true }),
                'Mod+K',
            ),
        ).toBe(false);
    });

    it('formats bindings for display', () => {
        expect(formatKeyBinding('Mod+Shift+ArrowLeft')).toBe('Ctrl+Shift+Left');
        expect(formatKeyBinding(null)).toBe('Unassigned');
    });

    it('maps Alt+1 through Alt+0 to the first ten pinned items', () => {
        expect(PINNED_ITEM_COMMANDS).toHaveLength(10);
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[0]]).toBe('Alt+1');
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[8]]).toBe('Alt+9');
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[9]]).toBe('Alt+0');
    });
});
