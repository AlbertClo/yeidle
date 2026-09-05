import { describe, expect, it } from 'vitest';
import {
    navigationDirectionForKeyboardEvent,
    navigationDirectionForMouseButton,
} from './navigationInputs';

function keyboardEvent(
    overrides: Partial<KeyboardEvent>,
): Pick<
    KeyboardEvent,
    'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
> {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        ...overrides,
    };
}

describe('navigation inputs', () => {
    it('maps mouse side buttons to back and forward', () => {
        expect(navigationDirectionForMouseButton(3)).toBe('back');
        expect(navigationDirectionForMouseButton(4)).toBe('forward');
        expect(navigationDirectionForMouseButton(1)).toBeNull();
    });

    it('supports standard Alt arrow navigation', () => {
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'ArrowLeft', altKey: true }),
            ),
        ).toBe('back');
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'ArrowRight', altKey: true }),
            ),
        ).toBe('forward');
    });

    it('supports macOS Command bracket navigation', () => {
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ code: 'BracketLeft', metaKey: true }),
            ),
        ).toBe('back');
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ code: 'BracketRight', metaKey: true }),
            ),
        ).toBe('forward');
    });

    it('supports dedicated browser navigation keys', () => {
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'BrowserBack' }),
            ),
        ).toBe('back');
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'BrowserForward' }),
            ),
        ).toBe('forward');
    });
});
