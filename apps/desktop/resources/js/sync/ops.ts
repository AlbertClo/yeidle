import { uuidv7 } from 'uuidv7';

import { HlcClock } from './hlc';

/**
 * Op producer for this window session (sync design §4–§5). The client_id is
 * ephemeral per window — one client_id per independent HLC generator — so
 * two windows can never mint colliding HLCs.
 */

export type Op = {
    op_id: string;
    client_id: string;
    hlc: string;
    type: 'node.set' | 'node.delete';
    payload: Record<string, unknown>;
};

const clientId = uuidv7();
const clock = new HlcClock(clientId);

export function getClientId(): string {
    return clientId;
}

/** Ratchet the session clock when remote ops are observed (pull path). */
export function observeHlc(hlc: string): void {
    clock.observe(hlc);
}

export function mintNodeSet(
    id: string,
    pageId: string,
    fields: Record<string, unknown>,
): Op {
    return {
        op_id: uuidv7(),
        client_id: clientId,
        hlc: clock.now(),
        type: 'node.set',
        payload: { v: 1, id, page_id: pageId, fields },
    };
}

export function mintNodeDelete(id: string, pageId: string): Op {
    return {
        op_id: uuidv7(),
        client_id: clientId,
        hlc: clock.now(),
        type: 'node.delete',
        payload: { v: 1, id, page_id: pageId },
    };
}

/**
 * Push ops to the sync endpoint. Idempotent server-side by op_id, so
 * re-pushing after a failure is always safe. Returns whether the push
 * succeeded.
 */
export async function pushOps(ops: Op[]): Promise<boolean> {
    if (ops.length === 0) {
        return true;
    }

    const body = JSON.stringify({ client_id: clientId, ops });

    try {
        const res = await fetch('/api/sync/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            // keepalive lets in-flight pushes survive teardown but rejects
            // bodies over ~64KB
            keepalive: body.length < 60000,
            body,
        });

        return res.ok;
    } catch {
        return false;
    }
}
