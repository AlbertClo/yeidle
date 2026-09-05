export type NavigationDirection = 'back' | 'forward';

type KeyboardNavigationInput = Pick<
    KeyboardEvent,
    'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
>;

export function navigationDirectionForMouseButton(
    button: number,
): NavigationDirection | null {
    if (button === 3) {
        return 'back';
    }

    if (button === 4) {
        return 'forward';
    }

    return null;
}

export function navigationDirectionForKeyboardEvent(
    event: KeyboardNavigationInput,
): NavigationDirection | null {
    if (event.key === 'BrowserBack') {
        return 'back';
    }

    if (event.key === 'BrowserForward') {
        return 'forward';
    }

    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (event.key === 'ArrowLeft') {
            return 'back';
        }

        if (event.key === 'ArrowRight') {
            return 'forward';
        }
    }

    if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (event.code === 'BracketLeft') {
            return 'back';
        }

        if (event.code === 'BracketRight') {
            return 'forward';
        }
    }

    return null;
}
