import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMaxWaitScheduler } from './maxWaitScheduler';

afterEach(() => {
    vi.useRealTimers();
});

describe('createMaxWaitScheduler', () => {
    it('runs after the trailing quiet period', () => {
        vi.useFakeTimers();
        const task = vi.fn();
        const scheduler = createMaxWaitScheduler(task, 300, 1000);

        scheduler.schedule();
        vi.advanceTimersByTime(299);
        expect(task).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(task).toHaveBeenCalledOnce();
    });

    it('resets the quiet period without extending the maximum wait', () => {
        vi.useFakeTimers();
        const task = vi.fn();
        const scheduler = createMaxWaitScheduler(task, 300, 1000);

        scheduler.schedule();

        for (let elapsed = 250; elapsed <= 750; elapsed += 250) {
            vi.advanceTimersByTime(250);
            scheduler.schedule();
        }

        vi.advanceTimersByTime(249);
        expect(task).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        expect(task).toHaveBeenCalledOnce();
    });

    it('can flush or cancel pending work', () => {
        vi.useFakeTimers();
        const task = vi.fn();
        const scheduler = createMaxWaitScheduler(task, 300, 1000);

        scheduler.schedule();
        scheduler.flush();
        expect(task).toHaveBeenCalledOnce();

        scheduler.schedule();
        scheduler.cancel();
        vi.runAllTimers();
        expect(task).toHaveBeenCalledOnce();
    });
});
