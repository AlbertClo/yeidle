/**
 * Produces the same initial sequence as fractional-indexing's
 * generateNKeysBetween(null, null, n): a0, a1, ... az, b00, b01, ...
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const positions: string[] = ['a0'];

export function positionAt(index: number): string {
    if (!Number.isInteger(index) || index < 0) {
        throw new RangeError('A sibling position cannot be negative.');
    }

    while (positions.length <= index) {
        positions.push(increment(positions[positions.length - 1]));
    }

    return positions[index];
}

function increment(position: string): string {
    let head = position[0];
    const digits = position.slice(1).split('');
    let carry = true;

    for (let i = digits.length - 1; carry && i >= 0; i--) {
        const digit = DIGITS.indexOf(digits[i]);

        if (digit === -1) {
            throw new RangeError(`Invalid fractional position [${position}].`);
        }

        if (digit + 1 === DIGITS.length) {
            digits[i] = DIGITS[0];
        } else {
            digits[i] = DIGITS[digit + 1];
            carry = false;
        }
    }

    if (!carry) {
        return head + digits.join('');
    }

    if (head === 'z') {
        throw new RangeError('Too many siblings to assign fractional positions.');
    }

    head = String.fromCharCode(head.charCodeAt(0) + 1);

    if (head > 'a') {
        digits.push(DIGITS[0]);
    } else {
        digits.pop();
    }

    return head + digits.join('');
}
