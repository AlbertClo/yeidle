import { Extension } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { EditorView } from '@tiptap/pm/view';

/**
 * Draws other windows' cursors: a colored caret with a name label, and a
 * tinted range for a selection. Positions are set from outside (see
 * setRemoteCursors) and mapped through local edits in between.
 */

export type EditorCursor = {
    key: string;
    label: string;
    color: string;
    anchor: number;
    head: number;
};

const pluginKey = new PluginKey<DecorationSet>('remoteCursors');

export const RemoteCursors = Extension.create({
    name: 'remoteCursors',

    addProseMirrorPlugins() {
        return [
            new Plugin<DecorationSet>({
                key: pluginKey,
                state: {
                    init: () => DecorationSet.empty,
                    apply(tr, decorations) {
                        const cursors = tr.getMeta(pluginKey) as
                            | EditorCursor[]
                            | undefined;

                        return cursors
                            ? build(tr.doc, cursors)
                            : decorations.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations: (state) => pluginKey.getState(state),
                },
            }),
        ];
    },
});

export function setRemoteCursors(
    view: EditorView,
    cursors: EditorCursor[],
): void {
    view.dispatch(
        view.state.tr
            .setMeta(pluginKey, cursors)
            .setMeta('addToHistory', false),
    );
}

function build(doc: PmNode, cursors: EditorCursor[]): DecorationSet {
    const size = doc.content.size;
    const decorations: Decoration[] = [];

    for (const cursor of cursors) {
        const anchor = clamp(cursor.anchor, size);
        const head = clamp(cursor.head, size);
        const from = Math.min(anchor, head);
        const to = Math.max(anchor, head);

        if (from < to) {
            decorations.push(
                Decoration.inline(from, to, {
                    class: 'remote-selection',
                    style: `background-color: ${withAlpha(cursor.color, 0.2)}`,
                }),
            );
        }

        decorations.push(
            Decoration.widget(head, () => caret(cursor), {
                // A new key per position re-creates the widget, so the
                // label shows again whenever the cursor moves
                key: `${cursor.key}:${head}:${cursor.label}`,
                side: 1,
                ignoreSelection: true,
            }),
        );
    }

    return DecorationSet.create(doc, decorations);
}

function caret(cursor: EditorCursor): HTMLElement {
    const caret = document.createElement('span');
    caret.className = 'remote-caret';
    caret.style.borderColor = cursor.color;
    caret.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'remote-caret-label';
    label.style.backgroundColor = cursor.color;
    label.textContent = cursor.label;
    caret.appendChild(label);

    return caret;
}

function clamp(pos: number, size: number): number {
    return Math.min(Math.max(0, pos), size);
}

/** `hsl(h s l)` → `hsl(h s l / alpha)`. */
function withAlpha(color: string, alpha: number): string {
    return color.startsWith('hsl(') && !color.includes('/')
        ? color.replace(/\)$/, ` / ${alpha})`)
        : color;
}
