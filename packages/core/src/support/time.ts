/** Timestamps as the read model stores them: UTC `Y-m-d H:i:s`. */
export function sqlTimestamp(date: Date = new Date()): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** A stored timestamp as JSON, in Laravel's format (`2026-11-09T04:35:21.000000Z`). */
export function jsonTimestamp(value: string | null | undefined): string | null {
    if (!value) {
        return null;
    }

    const date = parseTimestamp(value);

    return date === null ? null : `${date.toISOString().slice(0, 19)}.000000Z`;
}

/** Parses ISO 8601 or stored `Y-m-d H:i:s` (UTC) timestamps. */
export function parseTimestamp(value: string): Date | null {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
        ? `${value.replace(' ', 'T').slice(0, 19)}Z`
        : value;
    const date = new Date(normalized);

    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * nodes.modified_at: ISO 8601 with milliseconds, so ordering the text orders
 * by time (and recent edits within a second stay distinct).
 */
export function modifiedTimestamp(date: Date = new Date()): string {
    return date.toISOString();
}
