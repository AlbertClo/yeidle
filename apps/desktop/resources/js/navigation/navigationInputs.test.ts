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

    it('leaves Alt arrow combinations to configurable platform bindings', () => {
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'ArrowLeft', altKey: true }),
            ),
        ).toBeNull();
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ key: 'ArrowRight', altKey: true }),
            ),
        ).toBeNull();
    });

    it('leaves Command bracket combinations to configurable platform bindings', () => {
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ code: 'BracketLeft', metaKey: true }),
            ),
        ).toBeNull();
        expect(
            navigationDirectionForKeyboardEvent(
                keyboardEvent({ code: 'BracketRight', metaKey: true }),
            ),
        ).toBeNull();
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
