import { requestCloudExchange } from './cloud';
import { notifyLocalOpsAvailable } from './localOps';

export { LOCAL_OPS_AVAILABLE_EVENT } from './localOps';

export interface CommittedOpsEvent {
    workspace_id: string;
    origin_client_id: string;
    previous_seq: number;
    latest_seq: number;
    ops: Array<Record<string, unknown>> | null;
}

interface IngestResult {
    applied: number;
    needs_pull: boolean;
    ignored: boolean;
}

async function recoverWithPull(): Promise<void> {
    await requestCloudExchange();
}

/**
 * Hand a committed Reverb batch to the local PHP process. PHP owns cursor
 * checks, SQLite writes, and projection application; the renderer only wakes
 * open views after local persistence succeeds.
 */
export async function handleCommittedOps(
    event: CommittedOpsEvent,
): Promise<void> {
    try {
        const response = await fetch('/api/cloud/realtime-ops', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
        });

        if (!response.ok) {
            await recoverWithPull();

            return;
        }

        const result = (await response.json()) as IngestResult;

        if (result.needs_pull) {
            await recoverWithPull();
        } else if (!result.ignored && result.applied > 0) {
            notifyLocalOpsAvailable(event.ops);
        }
    } catch {
        await recoverWithPull();
    }
}

export async function recoverRealtimeSync(): Promise<void> {
    await recoverWithPull();
}
