import { blocksTree } from '@yeidle/core/loro/pageDoc';
import { Cursor, EphemeralStore, LoroText } from 'loro-crdt';
import type { LoroDoc } from 'loro-crdt';
import { uuidv7 } from 'uuidv7';

import type { BlockPosition } from './positions';

/**
 * Who is on a page and where their cursor is. Each window keeps its own
 * selection in a Loro ephemeral store (never stored, expires without a
 * heartbeat) and exchanges the store's updates with the other windows on
 * the page through `send` / `receive`.
 *
 * Positions are Loro cursors, which point at a character rather than an
 * offset, so a remote caret stays on the right character while text is
 * inserted before it. A cursor pointing at text this window doesn't have
 * yet resolves to nothing; it appears once that text has synced.
 */

export type PresenceIdentity = {
    userId: string | null;
    name: string | null;
    device: string | null;
};

export type LocalSelection = { anchor: BlockPosition; head: BlockPosition };

export type RemoteCursor = {
    key: string;
    label: string;
    color: string;
    anchor: BlockPosition;
    head: BlockPosition;
};

type CursorState = {
    user_id: string | null;
    name: string | null;
    device: string | null;
    anchor_block: string;
    anchor: Uint8Array;
    head_block: string;
    head: Uint8Array;
};

const EXPIRE_MS = 30_000;
const HEARTBEAT_MS = 10_000;

export class PagePresence {
    /** This window's key in the store (one per window and page). */
    readonly key = uuidv7();
    private store = new EphemeralStore<Record<string, CursorState>>(EXPIRE_MS);
    private listeners = new Set<() => void>();
    private heartbeat: ReturnType<typeof setInterval>;
    private unsubscribe: (() => void)[] = [];

    constructor(
        private doc: () => LoroDoc,
        private identity: PresenceIdentity,
        send: (bytes: Uint8Array) => void,
    ) {
        this.unsubscribe.push(
            this.store.subscribeLocalUpdates((bytes) => send(bytes)),
            this.store.subscribe((event) => {
                if (event.by !== 'local') {
                    this.emit();
                }
            }),
        );

        // Re-announce so the others don't expire this window while it's idle
        this.heartbeat = setInterval(() => {
            const state = this.store.get(this.key);

            if (state) {
                this.store.set(this.key, state);
            }
        }, HEARTBEAT_MS);
    }

    /** Publishes this window's selection (null hides its cursor). */
    setSelection(selection: LocalSelection | null): void {
        if (selection === null) {
            this.store.delete(this.key);

            return;
        }

        const anchor = this.cursorAt(selection.anchor);
        const head = this.cursorAt(selection.head);

        if (!anchor || !head) {
            return;
        }

        this.store.set(this.key, {
            user_id: this.identity.userId,
            name: this.identity.name,
            device: this.identity.device,
            anchor_block: selection.anchor.blockId,
            anchor,
            head_block: selection.head.blockId,
            head,
        });
    }

    /** Applies an update from another window. */
    receive(bytes: Uint8Array): void {
        this.store.apply(bytes);
    }

    /** Everything this window knows, for a window that just joined. */
    snapshot(): Uint8Array {
        return this.store.encodeAll();
    }

    /** Other windows' cursors, resolved against the current document. */
    remoteCursors(): RemoteCursor[] {
        const doc = this.doc();
        const cursors: RemoteCursor[] = [];

        for (const [key, state] of Object.entries(this.store.getAllStates())) {
            if (key === this.key || !state) {
                continue;
            }

            const anchor = resolve(doc, state.anchor);
            const head = resolve(doc, state.head);

            if (anchor === null || head === null) {
                continue;
            }

            cursors.push({
                key,
                label: this.label(state),
                color: colorFor(key),
                anchor: { blockId: state.anchor_block, index: anchor },
                head: { blockId: state.head_block, index: head },
            });
        }

        return cursors;
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /** Hides this window's cursor everywhere and stops. */
    leave(): void {
        this.store.delete(this.key);
        clearInterval(this.heartbeat);

        for (const unsubscribe of this.unsubscribe) {
            unsubscribe();
        }

        this.listeners.clear();
        this.store.destroy();
    }

    private label(state: CursorState): string {
        return state.name || 'Someone';
    }

    private cursorAt(position: BlockPosition): Uint8Array | null {
        const text = blockText(this.doc(), position.blockId);

        if (!text) {
            return null;
        }

        const index = Math.min(Math.max(0, position.index), text.length);

        return text.getCursor(index)?.encode() ?? null;
    }

    private emit(): void {
        for (const listener of this.listeners) {
            listener();
        }
    }
}

function blockText(doc: LoroDoc, blockId: string): LoroText | null {
    for (const node of blocksTree(doc).nodes()) {
        if (node.data.get('id') === blockId) {
            const text = node.data.get('text');

            return text instanceof LoroText ? text : null;
        }
    }

    return null;
}

function resolve(doc: LoroDoc, encoded: Uint8Array): number | null {
    try {
        return doc.getCursorPos(Cursor.decode(encoded))?.offset ?? null;
    } catch {
        return null;
    }
}

/** A stable, readable color per window. */
export function colorFor(key: string): string {
    let hash = 0;

    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }

    return `hsl(${hash % 360} 70% 45%)`;
}
