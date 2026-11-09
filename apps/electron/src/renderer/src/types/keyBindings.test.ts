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

    it.each([
        ['{', 'BracketLeft'],
        ['}', 'BracketRight'],
        ['|', 'Backslash'],
        [':', 'Semicolon'],
        ['"', 'Quote'],
        ['<', 'Comma'],
        ['>', 'Period'],
        ['?', 'Slash'],
        ['~', 'Backquote'],
        ['_', 'Minus'],
    ])('captures and matches shifted %s as %s', (key, code) => {
        const event = keyboardEvent(key, {
            code,
            ctrlKey: true,
            shiftKey: true,
        });
        const binding = `Ctrl+Shift+${code}`;

        expect(keyBindingFromEvent(event)).toBe(binding);
        expect(eventMatchesKeyBinding(event, binding)).toBe(true);
        expect(eventMatchesKeyBinding(event, `Ctrl+${code}`)).toBe(false);
    });

    it('recognizes shifted brackets with Command on Mac and either reported character', () => {
        for (const key of ['{', '[']) {
            const event = keyboardEvent(key, {
                code: 'BracketLeft',
                metaKey: true,
                shiftKey: true,
            });

            expect(keyBindingFromEvent(event)).toBe('Meta+Shift+BracketLeft');
            expect(
                eventMatchesKeyBinding(event, 'Mod+Shift+BracketLeft', 'mac'),
            ).toBe(true);
        }

        expect(formatKeyBinding('Ctrl+Shift+BracketLeft')).toBe('Ctrl+Shift+[');
    });

    it('handles shifted digits while preserving existing plus-key bindings', () => {
        const digit = keyboardEvent('!', {
            code: 'Digit1',
            ctrlKey: true,
            shiftKey: true,
        });
        const plus = keyboardEvent('+', {
            code: 'Equal',
            ctrlKey: true,
            shiftKey: true,
        });

        expect(keyBindingFromEvent(digit)).toBe('Ctrl+Shift+1');
        expect(eventMatchesKeyBinding(digit, 'Ctrl+Shift+1')).toBe(true);
        expect(keyBindingFromEvent(plus)).toBe('Ctrl+Shift+Plus');
        expect(eventMatchesKeyBinding(plus, 'Ctrl+Shift+Plus')).toBe(true);
    });

    it('does not fall back for unmodified punctuation, dead keys, IME or AltGr', () => {
        expect(
            keyBindingFromEvent(
                keyboardEvent('{', { code: 'BracketLeft', ctrlKey: true }),
            ),
        ).toBeNull();

        for (const overrides of [
            { key: 'Dead' },
            { isComposing: true },
            {
                altKey: true,
                getModifierState: (key: string) => key === 'AltGraph',
            },
        ]) {
            const event = keyboardEvent('{', {
                code: 'BracketLeft',
                ctrlKey: true,
                shiftKey: true,
                ...overrides,
            });

            expect(keyBindingFromEvent(event)).toBeNull();
            expect(
                eventMatchesKeyBinding(event, 'Ctrl+Shift+BracketLeft'),
            ).toBe(false);
        }
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

    it('uses the chosen Yeidle palette, search and follow-link shortcuts', () => {
        expect(DEFAULT_KEY_BINDINGS['command-palette']).toBe('Ctrl+K');
        expect(DEFAULT_KEY_BINDINGS['find-page']).toBe('Alt+E');
        expect(DEFAULT_KEY_BINDINGS['follow-link']).toBe('Ctrl+Q');
    });

    it('opens the raw Markdown editor with Ctrl or Command Shift M', () => {
        expect(DEFAULT_KEY_BINDINGS['edit-node-raw']).toBe('Mod+Shift+M');
    });

    it('uses arrows for single-node folding and minus/plus for subtree folding', () => {
        expect(DEFAULT_KEY_BINDINGS['collapse-node']).toBe('Mod+ArrowUp');
        expect(DEFAULT_KEY_BINDINGS['expand-node']).toBe('Mod+ArrowDown');
        expect(DEFAULT_KEY_BINDINGS['collapse-all-nodes']).toBe(
            'Ctrl+Shift+Minus',
        );
        expect(DEFAULT_KEY_BINDINGS['expand-all-nodes']).toBe(
            'Ctrl+Shift+Plus',
        );
    });

    it('opens today with Alt+D and adjacent days with shifted brackets', () => {
        expect(DEFAULT_KEY_BINDINGS['daily-notes']).toBe('Alt+D');
        expect(DEFAULT_KEY_BINDINGS['previous-daily-note']).toBe(
            'Ctrl+Shift+BracketLeft',
        );
        expect(DEFAULT_KEY_BINDINGS['next-daily-note']).toBe(
            'Ctrl+Shift+BracketRight',
        );
    });

    it('resolves Mod to exactly the platform modifier, rejecting extra modifiers', () => {
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('p', { metaKey: true }),
                'Mod+P',
                'mac',
            ),
        ).toBe(true);
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('p', { ctrlKey: true }),
                'Mod+P',
                'mac',
            ),
        ).toBe(false);
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('p', { metaKey: true }),
                'Mod+P',
                'other',
            ),
        ).toBe(false);
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('p', { metaKey: true, ctrlKey: true }),
                'Mod+P',
                'mac',
            ),
        ).toBe(false);
    });
    it('recognizes explicitly assigned Option shortcuts without losing the physical letter', () => {
        const event = keyboardEvent('å', { code: 'KeyA', altKey: true });
        expect(keyBindingFromEvent(event)).toBe('Alt+A');
        expect(eventMatchesKeyBinding(event, 'Alt+A', 'mac')).toBe(true);
    });
    it('does not intercept composition or AltGr typing', () => {
        expect(
            eventMatchesKeyBinding(
                keyboardEvent('p', { ctrlKey: true, isComposing: true }),
                'Mod+P',
            ),
        ).toBe(false);
        expect(
            keyBindingFromEvent(
                keyboardEvent('@', {
                    ctrlKey: true,
                    altKey: true,
                    code: 'KeyQ',
                    getModifierState: (key) => key === 'AltGraph',
                }),
            ),
        ).toBeNull();
    });
});
