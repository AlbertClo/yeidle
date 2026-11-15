import type { LoroDoc } from 'loro-crdt';
import { describe, expect, it } from 'vitest';

import { applyBlocks, createDoc, flattenBlocks, readBlocks } from './pageDoc';
import type { Block } from './pageDoc';

const PAGE = 'page-1';

type Spec = { id: string; text?: string; checked?: boolean; children?: Spec[] };

function blocks(specs: Spec[], parent = PAGE): Block[] {
    return specs.map((spec) => ({
        id: spec.id,
        parent_id: parent,
        position: '',
        content: spec.text ?? spec.id,
        tiptap_content: {
            type: 'paragraph',
            content: [{ type: 'text', text: spec.text ?? spec.id }],
        },
        is_checked: spec.checked ?? null,
        children: blocks(spec.children ?? [], spec.id),
    }));
}

/** The tree as nested [id, text, children] for readable assertions. */
function shape(doc: LoroDoc): unknown[] {
    const visit = (list: Block[]): unknown[] =>
        list.map((block) =>
            block.children && block.children.length > 0
                ? [block.content, visit(block.children)]
                : block.content,
        );

    return visit(readBlocks(doc, PAGE));
}

function edit(doc: LoroDoc, specs: Spec[]): void {
    applyBlocks(doc, blocks(specs));
    doc.commit();
}

function replicas(specs: Spec[]): [LoroDoc, LoroDoc] {
    const a = createDoc();
    a.setPeerId(1);
    edit(a, specs);
    const b = createDoc();
    b.setPeerId(2);
    b.import(a.export({ mode: 'snapshot' }));

    return [a, b];
}

function sync(a: LoroDoc, b: LoroDoc): void {
    const fromA = a.export({ mode: 'update', from: b.oplogVersion() });
    const fromB = b.export({ mode: 'update', from: a.oplogVersion() });
    a.import(fromB);
    b.import(fromA);
}

describe('page documents', () => {
    it('round-trips a nested page', () => {
        const doc = createDoc();
        edit(doc, [
            { id: 'a', children: [{ id: 'a1' }, { id: 'a2', checked: true }] },
            { id: 'b' },
        ]);

        const read = readBlocks(doc, PAGE);
        expect(shape(doc)).toEqual([['a', ['a1', 'a2']], 'b']);
        expect(read[0].parent_id).toBe(PAGE);
        expect(read[0].children![1]).toMatchObject({
            parent_id: 'a',
            is_checked: true,
        });
        expect(flattenBlocks(read).map((block) => block.id)).toEqual([
            'a',
            'a1',
            'a2',
            'b',
        ]);
        // Positions order the siblings
        expect(read[0].position < read[1].position).toBe(true);
    });

    it('makes no change when the page is unchanged', () => {
        const doc = createDoc();
        const page: Spec[] = [
            { id: 'a', children: [{ id: 'a1' }] },
            { id: 'b' },
        ];
        edit(doc, page);

        expect(applyBlocks(doc, blocks(page))).toBe(false);
    });

    it('moves only the block that changed place', () => {
        const doc = createDoc();
        edit(doc, [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);
        const before = doc.oplogVersion();
        edit(doc, [{ id: 'a' }, { id: 'c' }, { id: 'd' }, { id: 'b' }]);

        expect(shape(doc)).toEqual(['a', 'c', 'd', 'b']);
        expect(
            doc.exportJsonUpdates(before, doc.oplogVersion()).changes[0].ops,
        ).toHaveLength(1);
    });

    it('indents, outdents and deletes', () => {
        const doc = createDoc();
        edit(doc, [
            { id: 'a' },
            { id: 'b' },
            { id: 'c', children: [{ id: 'c1' }] },
        ]);
        edit(doc, [{ id: 'a', children: [{ id: 'b' }] }, { id: 'c1' }]);

        expect(shape(doc)).toEqual([['a', ['b']], 'c1']);
    });

    it('merges a move with a concurrent edit of the moved block', () => {
        const [a, b] = replicas([{ id: 'x' }, { id: 'y' }]);
        edit(a, [{ id: 'y' }, { id: 'x' }]);
        edit(b, [{ id: 'x', text: 'x edited' }, { id: 'y' }]);
        sync(a, b);

        expect(shape(a)).toEqual(['y', 'x edited']);
        expect(shape(b)).toEqual(shape(a));
    });

    it('keeps blocks added concurrently in different places', () => {
        const [a, b] = replicas([{ id: 'x' }, { id: 'y' }]);
        edit(a, [{ id: 'new-a' }, { id: 'x' }, { id: 'y' }]);
        edit(b, [{ id: 'x' }, { id: 'y', children: [{ id: 'new-b' }] }]);
        sync(a, b);

        expect(shape(a)).toEqual(['new-a', 'x', ['y', ['new-b']]]);
        expect(shape(b)).toEqual(shape(a));
    });

    it('converges when both replicas indent the same block differently', () => {
        const [a, b] = replicas([{ id: 'x' }, { id: 'y' }, { id: 'z' }]);
        edit(a, [{ id: 'x', children: [{ id: 'z' }] }, { id: 'y' }]);
        edit(b, [{ id: 'x' }, { id: 'y', children: [{ id: 'z' }] }]);
        sync(a, b);

        expect(shape(a)).toEqual(shape(b));
        expect(JSON.stringify(shape(a)).match(/"z"/g)).toHaveLength(1);
    });

    it('converges when concurrent moves would form a cycle', () => {
        const [a, b] = replicas([{ id: 'x' }, { id: 'y' }]);
        edit(a, [{ id: 'x', children: [{ id: 'y' }] }]);
        edit(b, [{ id: 'y', children: [{ id: 'x' }] }]);
        sync(a, b);

        expect(shape(a)).toEqual(shape(b));
        expect(flattenBlocks(readBlocks(a, PAGE))).toHaveLength(2);
    });

    it('gives a concurrently re-created block id its own identity', () => {
        const a = createDoc();
        a.setPeerId(1);
        const b = createDoc();
        b.setPeerId(2);
        edit(a, [{ id: 'same', text: 'from a' }]);
        edit(b, [{ id: 'same', text: 'from b' }]);
        sync(a, b);

        // Both survive; the next local write renames the duplicate
        const blocksA = readBlocks(a, PAGE);
        expect(blocksA).toHaveLength(1);
        applyBlocks(a, blocksA);
        a.commit();
        expect(readBlocks(a, PAGE)).toHaveLength(2);
    });
});
