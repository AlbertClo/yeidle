import { router } from '@inertiajs/vue3';

import { requestCloudExchange } from './sync/cloud';

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

export async function openDailyNote(date = localDateString()): Promise<void> {
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
    router.visit(`/pages/${page.id}`);
}
