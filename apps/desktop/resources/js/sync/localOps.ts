import { invalidateInactiveCachedPages } from '../stores/pageCache';

export const LOCAL_OPS_AVAILABLE_EVENT = 'yeidle:local-ops-available';

export type CommittedOp = Record<string, unknown>;

export interface LocalOpsAvailableDetail {
    // null means the durable pull path applied operations but did not retain
    // their wire payload in the renderer.
    ops: CommittedOp[] | null;
}

export type LocalOpsAvailableEvent = CustomEvent<LocalOpsAvailableDetail>;

export function notifyLocalOpsAvailable(ops: CommittedOp[] | null): void {
    invalidateInactiveCachedPages(ops);

    window.dispatchEvent(
        new CustomEvent<LocalOpsAvailableDetail>(LOCAL_OPS_AVAILABLE_EVENT, {
            detail: { ops },
        }),
    );
}

/** Whether a committed batch may have changed the top-level Pages list. */
export function opsAffectPageIndex(ops: CommittedOp[] | null): boolean {
    if (ops === null) {
        return true;
    }

    return ops.some((op) => {
        const payload = op.payload;

        if (typeof payload !== 'object' || payload === null) {
            return false;
        }

        const fields = payload as Record<string, unknown>;

        return (
            typeof fields.id === 'string' &&
            typeof fields.page_id === 'string' &&
            fields.id === fields.page_id
        );
    });
}
