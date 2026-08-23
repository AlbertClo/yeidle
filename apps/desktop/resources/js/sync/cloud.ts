import { notifyLocalOpsAvailable } from './localOps';

let exchangeRequested = false;
let exchangeRun: Promise<boolean> | null = null;

async function exchangeOnce(): Promise<boolean> {
    try {
        const response = await fetch('/api/sync/cloud-exchange', {
            method: 'POST',
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            return false;
        }

        try {
            const result = (await response.json()) as { pulled?: unknown };

            if (typeof result.pulled === 'number' && result.pulled > 0) {
                notifyLocalOpsAvailable(null);
            }
        } catch {
            // The HTTP acknowledgement is sufficient for callers that do not
            // need renderer wake-ups (and keeps simplified test responses
            // compatible with this transport helper).
        }

        return true;
    } catch {
        return false;
    }
}

async function drainExchangeRequests(): Promise<boolean> {
    let succeeded = true;

    while (exchangeRequested) {
        exchangeRequested = false;

        succeeded = await exchangeOnce();
    }

    return succeeded;
}

/**
 * Ask the local server to exchange its outbox with the cloud. Concurrent
 * callers share one runner; requests arriving during an exchange are folded
 * into one follow-up round so ops written mid-flight are not left waiting for
 * another local write or realtime reconnect.
 */
export function requestCloudExchange(): Promise<boolean> {
    exchangeRequested = true;

    if (exchangeRun === null) {
        exchangeRun = drainExchangeRequests().finally(() => {
            exchangeRun = null;

            // Covers the small window between the drain finishing and this
            // cleanup callback running.
            if (exchangeRequested) {
                void requestCloudExchange();
            }
        });
    }

    return exchangeRun;
}
