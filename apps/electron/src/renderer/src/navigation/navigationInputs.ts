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

    // All key combinations use the configurable, platform-specific bindings.
    // In particular, Option+arrows must remain word movement on macOS.
    return null;
}
