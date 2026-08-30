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
    it('preserves physical control and command modifiers', () => {
        expect(keyBindingFromEvent(keyboardEvent('k', { ctrlKey: true }))).toBe(
            'Ctrl+K',
        );
        expect(keyBindingFromEvent(keyboardEvent('k', { metaKey: true }))).toBe(
            'Meta+K',
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
        ).toBe('Ctrl+Shift+P');
        expect(keyBindingFromEvent(keyboardEvent('/', { ctrlKey: true }))).toBe(
            'Ctrl+Slash',
        );
        expect(
            keyBindingFromEvent(keyboardEvent('\\', { ctrlKey: true })),
        ).toBe('Ctrl+Backslash');
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
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('o', { ctrlKey: true }),
                'Ctrl+O',
            ),
        ).toBe(true);
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('o', { metaKey: true }),
                'Ctrl+O',
            ),
        ).toBe(false);
    });

    it('formats bindings for display', () => {
        expect(formatKeyBinding('Mod+Shift+ArrowLeft')).toBe('Ctrl+Shift+Left');
        expect(formatKeyBinding('Mod+Backslash')).toBe('Ctrl+\\');
        expect(formatKeyBinding(null)).toBe('Unassigned');
    });

    it('maps Alt+1 through Alt+0 to the first ten pinned items', () => {
        expect(PINNED_ITEM_COMMANDS).toHaveLength(10);
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[0]]).toBe('Alt+1');
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[8]]).toBe('Alt+9');
        expect(DEFAULT_KEY_BINDINGS[PINNED_ITEM_COMMANDS[9]]).toBe('Alt+0');
    });

    it('opens navigation history with Ctrl or Command H', () => {
        expect(DEFAULT_KEY_BINDINGS['navigation-history']).toBe('Mod+H');
    });

    it("follows the link under the cursor with Roam Research's shortcut", () => {
        expect(DEFAULT_KEY_BINDINGS['follow-link']).toBe('Ctrl+O');
    });

    it("uses Roam Research's node collapse and expansion shortcuts", () => {
        expect(DEFAULT_KEY_BINDINGS['collapse-node']).toBe('Mod+ArrowUp');
        expect(DEFAULT_KEY_BINDINGS['expand-node']).toBe('Mod+ArrowDown');
    });

    it("opens daily notes with Roam Research's shortcuts", () => {
        expect(DEFAULT_KEY_BINDINGS['daily-notes']).toBe('Alt+D');
        expect(DEFAULT_KEY_BINDINGS['previous-daily-note']).toBe('Ctrl+Alt+P');
        expect(DEFAULT_KEY_BINDINGS['next-daily-note']).toBe('Ctrl+Alt+N');
    });
});
