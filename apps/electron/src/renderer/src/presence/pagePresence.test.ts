import { applyBlocks, createDoc, readBlocks } from '@yeidle/core/loro/pageDoc';
import type { Block } from '@yeidle/core/loro/pageDoc';
import type { LoroDoc } from 'loro-crdt';
import { afterEach, describe, expect, it } from 'vitest';

import { PagePresence } from './pagePresence';

const PAGE = 'page';

function block(id: string, text: string): Block {
    return {
        id,
        parent_id: PAGE,
        position: 'a0',
        content: text,
        tiptap_content: {
            type: 'paragraph',
            content: text ? [{ type: 'text', text }] : [],
        },
        is_checked: null,
    };
}

const opened: PagePresence[] = [];

afterEach(() => {
    while (opened.length > 0) {
        opened.pop()!.leave();
    }
});

/** Two windows on one page, wired to each other. */
function pair() {
    const docA = createDoc();
    applyBlocks(docA, [block('b1', 'hello world')]);
    docA.commit();
    const docB = createDoc();
    docB.import(docA.export({ mode: 'snapshot' }));

    const presences: { a?: PagePresence; b?: PagePresence } = {};
    presences.a = new PagePresence(
        () => docA,
        { userId: '1', name: 'Albert', device: 'laptop' },
        (bytes) => presences.b?.receive(bytes),
    );
    presences.b = new PagePresence(
        () => docB,
        { userId: '2', name: 'Bea', device: 'desktop' },
        (bytes) => presences.a?.receive(bytes),
    );
    opened.push(presences.a, presences.b);

    return { docA, docB, a: presences.a, b: presences.b };
}

const at = (index: number) => ({ blockId: 'b1', index });

function typeAt(doc: LoroDoc, text: string) {
    applyBlocks(doc, [block('b1', text)]);
    doc.commit();
}

describe('PagePresence', () => {
    it("shows the other window's selection, labelled", () => {
        const { a, b } = pair();
        a.setSelection({ anchor: at(0), head: at(5) });

        expect(b.remoteCursors()).toEqual([
            expect.objectContaining({
                key: a.key,
                label: 'Albert',
                anchor: at(0),
                head: at(5),
            }),
        ]);
        expect(a.remoteCursors()).toEqual([]);
    });

    it('keeps a caret on its character when text is inserted before it', () => {
        const { docA, docB, a, b } = pair();
        a.setSelection({ anchor: at(6), head: at(6) }); // before "world"

        typeAt(docB, 'oh, hello world');

        expect(b.remoteCursors()[0].head).toEqual(at(10));
        void docA;
    });

    it('hides a caret on text that has not arrived yet, then shows it', () => {
        const { docA, docB, a, b } = pair();
        typeAt(docA, 'hello world!!');
        a.setSelection({ anchor: at(12), head: at(12) });

        // The cursor points at a character B doesn't have
        expect(b.remoteCursors()).toEqual([]);

        docB.import(docA.export({ mode: 'update', from: docB.oplogVersion() }));
        expect(b.remoteCursors()[0].head).toEqual(at(12));
    });

    it('removes a window that leaves', async () => {
        const { a, b } = pair();
        a.setSelection({ anchor: at(1), head: at(1) });
        expect(b.remoteCursors()).toHaveLength(1);

        // The store orders entries by millisecond timestamp
        await new Promise((resolve) => setTimeout(resolve, 5));
        a.setSelection(null);
        expect(b.remoteCursors()).toEqual([]);
    });

    it('labels your own other device with just your name', () => {
        const docA = createDoc();
        applyBlocks(docA, [block('b1', 'x')]);
        docA.commit();
        const holder: { other?: PagePresence } = {};
        const mine = new PagePresence(
            () => docA,
            { userId: '1', name: 'Albert', device: 'laptop' },
            (bytes) => holder.other?.receive(bytes),
        );
        holder.other = new PagePresence(
            () => docA,
            { userId: '1', name: 'Albert', device: 'desktop' },
            () => undefined,
        );
        opened.push(mine, holder.other);

        mine.setSelection({ anchor: at(0), head: at(0) });

        expect(holder.other.remoteCursors()[0].label).toBe('Albert');
        expect(readBlocks(docA, PAGE)).toHaveLength(1);
    });
});
