export interface MaxWaitScheduler {
    schedule: () => void;
    flush: () => void;
    cancel: () => void;
}

/**
 * Runs a task after a quiet period, while guaranteeing that a continuous
 * stream of schedules cannot postpone it beyond maxWaitMs.
 */
export function createMaxWaitScheduler(
    task: () => void,
    waitMs: number,
    maxWaitMs: number,
): MaxWaitScheduler {
    if (waitMs < 0 || maxWaitMs < waitMs) {
        throw new RangeError('maxWaitMs must be at least waitMs');
    }

    let waitTimer: ReturnType<typeof setTimeout> | null = null;
    let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
    let scheduled = false;

    function clearTimers(): void {
        if (waitTimer !== null) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }

        if (maxWaitTimer !== null) {
            clearTimeout(maxWaitTimer);
            maxWaitTimer = null;
        }
    }

    function invoke(): void {
        if (!scheduled) {
            return;
        }

        scheduled = false;
        clearTimers();
        task();
    }

    return {
        schedule(): void {
            scheduled = true;

            if (waitTimer !== null) {
                clearTimeout(waitTimer);
            }

            waitTimer = setTimeout(invoke, waitMs);

            if (maxWaitTimer === null) {
                maxWaitTimer = setTimeout(invoke, maxWaitMs);
            }
        },

        flush(): void {
            invoke();
        },

        cancel(): void {
            scheduled = false;
            clearTimers();
        },
    };
}
