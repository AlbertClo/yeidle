/**
 * Parses an ISO 8601 timestamp (or `Y-m-d H:i:s`, read as UTC). Returns
 * null for anything that isn't a time.
 */
export function parseTimestamp(value: string): Date | null {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)
        ? `${value.replace(' ', 'T').slice(0, 19)}Z`
        : value;
    const date = new Date(normalized);

    return Number.isNaN(date.getTime()) ? null : date;
}
