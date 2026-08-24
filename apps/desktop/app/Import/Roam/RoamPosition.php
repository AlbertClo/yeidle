<?php

namespace App\Import\Roam;

/**
 * Produces the same initial sequence as fractional-indexing's
 * generateNKeysBetween(null, null, n): a0, a1, ... az, b00, b01, ...
 */
final class RoamPosition
{
    private const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

    /** @var array<int, string> */
    private static array $positions = ['a0'];

    public static function at(int $index): string
    {
        if ($index < 0) {
            throw new \InvalidArgumentException('A sibling position cannot be negative.');
        }

        while (! isset(self::$positions[$index])) {
            self::$positions[] = self::increment(self::$positions[array_key_last(self::$positions)]);
        }

        return self::$positions[$index];
    }

    private static function increment(string $position): string
    {
        $head = $position[0];
        $digits = str_split(substr($position, 1));
        $carry = true;

        for ($index = count($digits) - 1; $carry && $index >= 0; $index--) {
            $digit = strpos(self::DIGITS, $digits[$index]);

            if ($digit === false) {
                throw new \InvalidArgumentException("Invalid fractional position [{$position}].");
            }

            $digit++;
            if ($digit === strlen(self::DIGITS)) {
                $digits[$index] = self::DIGITS[0];
            } else {
                $digits[$index] = self::DIGITS[$digit];
                $carry = false;
            }
        }

        if (! $carry) {
            return $head.implode('', $digits);
        }

        if ($head === 'z') {
            throw new \OverflowException('Too many Roam siblings to assign fractional positions.');
        }

        $head = chr(ord($head) + 1);

        if ($head > 'a') {
            $digits[] = self::DIGITS[0];
        } else {
            array_pop($digits);
        }

        return $head.implode('', $digits);
    }
}
