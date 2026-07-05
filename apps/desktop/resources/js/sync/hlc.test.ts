import { describe, expect, it } from 'vitest';

import vectors from '../../../tests/Fixtures/hlc-vectors.json';
import { encodeHlc, HlcClock, parseHlc } from './hlc';

describe('shared vectors (parity with PHP)', () => {
    it('matches every encoding vector', () => {
        for (const v of vectors.encode) {
            expect(encodeHlc(v.millis, v.counter, v.clientId)).toBe(v.expected);
        }
    });

    it('orders every ordering vector', () => {
        for (const [lesser, greater] of vectors.ordering) {
            expect(lesser < greater).toBe(true);
        }
    });
});

describe('HlcClock', () => {
    it('is monotonic when the wall clock stalls', () => {
        const clock = new HlcClock('c1', () => 1000);
        const a = clock.now();
        const b = clock.now();
        const c = clock.now();

        expect(a < b && b < c).toBe(true);
        expect(parseHlc(c).millis).toBe(1000);
    });

    it('is monotonic when the wall clock regresses', () => {
        const times = [5000, 3000, 3000];
        const clock = new HlcClock('c1', () => times.shift()!);
        const a = clock.now();
        const b = clock.now();
        const c = clock.now();

        expect(a < b && b < c).toBe(true);
        expect(parseHlc(c).millis).toBe(5000);
    });

    it('observe ratchets past remote clocks', () => {
        const clock = new HlcClock('aa', () => 1000);
        const remote = encodeHlc(9000, 7, 'zz');
        clock.observe(remote);

        expect(clock.now() > remote).toBe(true);
    });

    it('rolls the counter into millis on overflow', () => {
        const clock = new HlcClock('c1', () => 1000);
        clock.observe(encodeHlc(1000, 0xffff, 'c1'));

        expect(parseHlc(clock.now()).millis).toBe(1001);
    });

    it('round-trips parse', () => {
        expect(parseHlc(encodeHlc(1751793445123, 66, 'client-x'))).toEqual({
            millis: 1751793445123,
            counter: 66,
        });
    });
});
