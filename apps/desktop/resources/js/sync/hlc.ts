/**
 * Hybrid Logical Clock — the TypeScript twin of app/Sync/HlcGenerator.php.
 * Both implementations are pinned to the same encoding and ordering by
 * tests/Fixtures/hlc-vectors.json; change one only in lockstep with the
 * other. HLCs are lexicographically comparable strings:
 * {millis:15}-{counter:4 hex}-{client_id}.
 */

export const HLC_EPOCH = '';

export function encodeHlc(
    millis: number,
    counter: number,
    clientId: string,
): string {
    return (
        String(millis).padStart(15, '0') +
        '-' +
        counter.toString(16).padStart(4, '0') +
        '-' +
        clientId
    );
}

export function parseHlc(hlc: string): { millis: number; counter: number } {
    return {
        millis: parseInt(hlc.slice(0, 15), 10),
        counter: parseInt(hlc.slice(16, 20), 16),
    };
}

export class HlcClock {
    private last = '';

    constructor(
        public readonly clientId: string,
        private nowMs: () => number = Date.now,
    ) {}

    now(): string {
        const wall = this.nowMs();

        if (this.last === '') {
            this.last = encodeHlc(wall, 0, this.clientId);

            return this.last;
        }

        const { millis, counter } = parseHlc(this.last);

        if (wall > millis) {
            this.last = encodeHlc(wall, 0, this.clientId);
        } else if (counter + 1 > 0xffff) {
            this.last = encodeHlc(millis + 1, 0, this.clientId);
        } else {
            this.last = encodeHlc(millis, counter + 1, this.clientId);
        }

        return this.last;
    }

    /** Ratchet past a remote clock so local time orders after everything seen. */
    observe(remote: string): void {
        if (remote > this.last) {
            const { millis, counter } = parseHlc(remote);
            this.last = encodeHlc(millis, counter, this.clientId);
        }
    }
}
