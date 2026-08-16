import { requestCloudExchange } from './cloud';

export const LOCAL_OPS_AVAILABLE_EVENT = 'yeidle:local-ops-available';

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

function notifyLocalOpsAvailable(): void {
    window.dispatchEvent(new Event(LOCAL_OPS_AVAILABLE_EVENT));
}

async function recoverWithPull(): Promise<void> {
    if (await requestCloudExchange()) {
        notifyLocalOpsAvailable();
    }
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
            notifyLocalOpsAvailable();
        }
    } catch {
        await recoverWithPull();
    }
}

export async function recoverRealtimeSync(): Promise<void> {
    await recoverWithPull();
}
