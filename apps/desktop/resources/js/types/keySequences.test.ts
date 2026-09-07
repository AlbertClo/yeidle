import { describe, expect, it } from 'vitest';
import { keyBindingsFromPreset } from './keyBindingPresets';
import { KeySequenceMatcher } from './keySequences';

const bindings = keyBindingsFromPreset('logseq', 'other');
const key = (value: string, extra: Partial<KeyboardEvent> = {}) =>
    ({
        key: value,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: null,
        ...extra,
    }) as KeyboardEvent;

describe('key sequences', () => {
    it('waits for a prefix and resolves exactly one command', () => {
        const matcher = new KeySequenceMatcher();
        expect(matcher.match(key('g'), bindings, false, 0).prefix).toBe(true);
        const result = matcher.match(key('a'), bindings, false, 100);
        expect([...result.commands]).toEqual(['all-pages']);
        expect(result.prefix).toBe(false);
        expect(
            matcher.match(key('a'), bindings, false, 200).commands.size,
        ).toBe(0);
    });
    it('never interprets typing or IME composition as a sequence', () => {
        const matcher = new KeySequenceMatcher();
        expect(matcher.match(key('g'), bindings, true, 0).prefix).toBe(false);
        expect(matcher.match(key('a'), bindings, true, 100).commands.size).toBe(
            0,
        );
        expect(
            matcher.match(key('g', { isComposing: true }), bindings, false, 200)
                .prefix,
        ).toBe(false);
    });
    it('expires prefixes and clears them when focus moves or a modal opens', () => {
        const matcher = new KeySequenceMatcher();
        matcher.match(key('g'), bindings, false, 0);
        expect(
            matcher.match(key('a'), bindings, false, 2000).commands.size,
        ).toBe(0);
        matcher.match(key('g'), bindings, false, 2100);
        expect(
            matcher.match(
                key('a', { target: new EventTarget() }),
                bindings,
                false,
                2200,
            ).commands.size,
        ).toBe(0);
        matcher.match(key('g'), bindings, false, 2300);
        matcher.reset();
        expect(
            matcher.match(key('a'), bindings, false, 2400).commands.size,
        ).toBe(0);
    });
    it('allows normal modified shortcuts while editing and ignores a repeated prefix', () => {
        const matcher = new KeySequenceMatcher();
        expect([
            ...matcher.match(key('k', { ctrlKey: true }), bindings, true)
                .commands,
        ]).toEqual(['find-page']);
        matcher.match(key('g'), bindings, false, 0);
        expect(
            matcher.match(key('g', { repeat: true }), bindings, false, 100)
                .prefix,
        ).toBe(true);
        expect([
            ...matcher.match(key('j'), bindings, false, 200).commands,
        ]).toEqual(['daily-notes']);
    });
});
