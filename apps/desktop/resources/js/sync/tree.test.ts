import { describe, expect, it } from 'vitest';

import type { Node } from '@/types/node';

import type { Op } from './ops';
import { applyOpsToTree, findInTree } from './tree';

const PAGE = 'page-1';

function node(
    id: string,
    parent: string,
    position: string,
    content = '',
): Node {
    return {
        id,
        parent_id: parent,
        position,
        content,
        tiptap_content: null,
        is_checked: null,
        modified_hlc: '',
        created_at: '',
        updated_at: '',
        children: [],
    };
}

function op(type: Op['type'], payload: Record<string, unknown>): Op {
    return {
        op_id: `op-${Math.random()}`,
        client_id: 'remote',
        hlc: '001',
        type,
        payload: { v: 1, page_id: PAGE, ...payload },
    };
}

function tree(): Node[] {
    const a = node('a', PAGE, 'a0', 'alpha');
    const b = node('b', PAGE, 'a1', 'beta');
    const c = node('c', 'a', 'a0', 'child');
    a.children = [c];

    return [a, b];
}

describe('applyOpsToTree', () => {
    it('applies content-only changes with content severity', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', { id: 'a', fields: { content: 'ALPHA' } }),
        ]);

        expect(result.change).toBe('content');
        expect(result.contentChanged).toEqual(['a']);
        expect(findInTree(roots, 'a')?.content).toBe('ALPHA');
    });

    it('inserts new nodes sorted by position', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', {
                id: 'x',
                fields: { parent_id: PAGE, position: 'a0V', content: 'mid' },
            }),
        ]);

        expect(result.change).toBe('structural');
        expect(roots.map((n) => n.id)).toEqual(['a', 'x', 'b']);
    });

    it('moves a node between parents', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', {
                id: 'c',
                fields: { parent_id: 'b', position: 'a0' },
            }),
        ]);

        expect(result.change).toBe('structural');
        expect(findInTree(roots, 'a')?.children).toEqual([]);
        expect(findInTree(roots, 'b')?.children?.map((n) => n.id)).toEqual([
            'c',
        ]);
    });

    it('reorders within siblings on position change', () => {
        const roots = tree();
        applyOpsToTree(roots, PAGE, [
            op('node.set', { id: 'a', fields: { position: 'a2' } }),
        ]);

        expect(roots.map((n) => n.id)).toEqual(['b', 'a']);
    });

    it('removes deleted subtrees', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.delete', { id: 'a' }),
        ]);

        expect(result.change).toBe('structural');
        expect(roots.map((n) => n.id)).toEqual(['b']);
        expect(findInTree(roots, 'c')).toBeNull();
    });

    it('moves a node out of the page tree when the parent is unknown', () => {
        const roots = tree();
        applyOpsToTree(roots, PAGE, [
            op('node.set', {
                id: 'c',
                fields: { parent_id: 'other-page-node' },
            }),
        ]);

        expect(findInTree(roots, 'c')).toBeNull();
    });

    it('ignores new nodes whose parent is not visible', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', {
                id: 'y',
                fields: { parent_id: 'nope', position: 'a0' },
            }),
        ]);

        expect(result.change).toBe('none');
        expect(findInTree(roots, 'y')).toBeNull();
    });

    it('handles create-then-nest sequences in one batch', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', {
                id: 'p',
                fields: { parent_id: PAGE, position: 'a5', content: 'parent' },
            }),
            op('node.set', {
                id: 'q',
                fields: { parent_id: 'p', position: 'a0', content: 'nested' },
            }),
        ]);

        expect(result.change).toBe('structural');
        expect(findInTree(roots, 'p')?.children?.map((n) => n.id)).toEqual([
            'q',
        ]);
    });

    it('coerces null content to empty string', () => {
        const roots = tree();
        applyOpsToTree(roots, PAGE, [
            op('node.set', { id: 'a', fields: { content: null } }),
        ]);

        expect(findInTree(roots, 'a')?.content).toBe('');
    });

    it('reports structural over content severity', () => {
        const roots = tree();
        const result = applyOpsToTree(roots, PAGE, [
            op('node.set', { id: 'a', fields: { content: 'edited' } }),
            op('node.delete', { id: 'b' }),
        ]);

        expect(result.change).toBe('structural');
    });
});
