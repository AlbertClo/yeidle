import { router } from '@inertiajs/vue3';

import { requestCloudExchange } from './sync/cloud';

const HOLD_DELAY_MS = 350;
const HOLD_REPEAT_MS = 120;

type DailyNoteDirection = -1 | 1;

export type DailyNoteFocus = 'start' | 'end';

type DailyNoteTraversal = {
    date: string;
    direction: DailyNoteDirection;
    inFlight: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    onError: () => void;
};

let activeTraversal: DailyNoteTraversal | null = null;

export function localDateString(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

export function adjacentDate(date: string, offset: number): string {
    const [year, month, day] = date.split('-').map(Number);
    const shifted = new Date(year, month - 1, day + offset);

    return localDateString(shifted);
}

export async function openDailyNote(
    date = localDateString(),
    focus?: DailyNoteFocus,
): Promise<void> {
    const response = await fetch('/api/daily-notes', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify({ date }),
    });

    if (!response.ok) {
        throw new Error('Could not open the daily note.');
    }

    const page = (await response.json()) as { id: string };
    void requestCloudExchange();
    await new Promise<void>((resolve) => {
        const query = focus ? `?dailyFocus=${focus}` : '';

        router.visit(`/pages/${page.id}${query}`, {
            onFinish: () => resolve(),
        });
    });
}

export function startDailyNoteTraversal(
    date: string,
    direction: DailyNoteDirection,
    onError: () => void,
): void {
    if (activeTraversal?.direction === direction) {
        return;
    }

    stopDailyNoteTraversal();

    const traversal: DailyNoteTraversal = {
        date,
        direction,
        inFlight: false,
        timer: null,
        onError,
    };

    activeTraversal = traversal;
    attachTraversalListeners();
    advanceDailyNoteTraversal(traversal);
    traversal.timer = setTimeout(
        () => repeatDailyNoteTraversal(traversal),
        HOLD_DELAY_MS,
    );
}

export function stopDailyNoteTraversal(): void {
    const traversal = activeTraversal;

    if (traversal && traversal.timer !== null) {
        clearTimeout(traversal.timer);
    }

    activeTraversal = null;
    detachTraversalListeners();
}

function repeatDailyNoteTraversal(traversal: DailyNoteTraversal): void {
    if (activeTraversal !== traversal) {
        return;
    }

    advanceDailyNoteTraversal(traversal);
    traversal.timer = setTimeout(
        () => repeatDailyNoteTraversal(traversal),
        HOLD_REPEAT_MS,
    );
}

function advanceDailyNoteTraversal(traversal: DailyNoteTraversal): void {
    if (activeTraversal !== traversal || traversal.inFlight) {
        return;
    }

    traversal.inFlight = true;
    traversal.date = adjacentDate(traversal.date, traversal.direction);

    void openDailyNote(traversal.date)
        .catch(() => {
            if (activeTraversal === traversal) {
                stopDailyNoteTraversal();
                traversal.onError();
            }
        })
        .finally(() => {
            traversal.inFlight = false;
        });
}

function attachTraversalListeners(): void {
    document.addEventListener('keyup', stopDailyNoteTraversal);
    window.addEventListener('blur', stopDailyNoteTraversal);
}

function detachTraversalListeners(): void {
    document.removeEventListener('keyup', stopDailyNoteTraversal);
    window.removeEventListener('blur', stopDailyNoteTraversal);
}
