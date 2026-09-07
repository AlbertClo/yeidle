export type KeyboardPlatform = 'mac' | 'other';

export function keyboardPlatform(): KeyboardPlatform {
    return typeof navigator !== 'undefined' &&
        /Mac|iPhone|iPad/.test(navigator.platform)
        ? 'mac'
        : 'other';
}
