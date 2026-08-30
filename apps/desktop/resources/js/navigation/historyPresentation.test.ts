import { describe, expect, it } from 'vitest';
import { navigationHistoryRows } from './historyPresentation';

type Location = {
    id: string;
    parent_id: string | null;
    visited_at: string;
    last_visited_at: string;
};

function location(
    id: string,
    parentId: string | null,
    visitedAt: string,
    lastVisitedAt = visitedAt,
): Location {
    return {
        id,
        parent_id: parentId,
        visited_at: visitedAt,
        last_visited_at: lastVisitedAt,
    };
}

describe('navigation history presentation', () => {
    it('shows the most recently visited location first', () => {
        const rows = navigationHistoryRows(
            [
                location('first', null, '2026-08-30T01:00:00Z'),
                location('second', 'first', '2026-08-30T02:00:00Z'),
            ],
            'second',
        );

        expect(rows.map((row) => row.id)).toEqual(['second', 'first']);
    });

    it('shows the back and forward path and hides abandoned branches', () => {
        const rows = navigationHistoryRows(
            [
                location('root', null, '2026-08-30T01:00:00Z'),
                location('old-branch', 'root', '2026-08-30T02:00:00Z'),
                location('old-child', 'old-branch', '2026-08-30T03:00:00Z'),
                location('current-branch', 'root', '2026-08-30T04:00:00Z'),
                location('current', 'current-branch', '2026-08-30T05:00:00Z'),
                location('forward', 'current', '2026-08-30T06:00:00Z'),
            ],
            'current',
        );

        expect(rows.map((row) => [row.id, row.depth])).toEqual([
            ['forward', 0],
            ['current', 0],
            ['current-branch', 0],
            ['root', 0],
        ]);
    });

    it('uses the most recently visited child as the forward path', () => {
        const rows = navigationHistoryRows(
            [
                location('root', null, '2026-08-30T01:00:00Z'),
                location(
                    'older',
                    'root',
                    '2026-08-30T02:00:00Z',
                    '2026-08-30T04:00:00Z',
                ),
                location(
                    'newer',
                    'root',
                    '2026-08-30T03:00:00Z',
                    '2026-08-30T05:00:00Z',
                ),
            ],
            'root',
        );
        expect(rows.map((row) => [row.id, row.depth])).toEqual([
            ['newer', 0],
            ['root', 0],
        ]);
    });
});
