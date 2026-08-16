let exchangeRequested = false;
let exchangeRun: Promise<boolean> | null = null;

async function exchangeOnce(): Promise<boolean> {
    try {
        const response = await fetch('/api/sync/cloud-exchange', {
            method: 'POST',
            headers: { Accept: 'application/json' },
        });

        return response.ok;
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
 * the heartbeat.
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
