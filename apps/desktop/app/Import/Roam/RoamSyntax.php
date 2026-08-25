<?php

namespace App\Import\Roam;

final class RoamSyntax
{
    /** @return list<array{offset: int, length: int}> */
    public static function codeRanges(string $source): array
    {
        $ranges = [];

        foreach (['~```.*?(?:```|\z)~su', '~(?<!`)`[^`\r\n]*`(?!`)~u'] as $pattern) {
            if (! preg_match_all($pattern, $source, $matches, PREG_OFFSET_CAPTURE)) {
                continue;
            }

            foreach ($matches[0] as $match) {
                $ranges[] = [
                    'offset' => $match[1],
                    'length' => strlen($match[0]),
                ];
            }
        }

        return $ranges;
    }

    /** @return list<array{offset: int, length: int}> */
    public static function componentNameRanges(string $source): array
    {
        $ranges = [];

        if (! preg_match_all(
            '~\{\{\s*(\[\[[^\]]+\]\])~u',
            $source,
            $matches,
            PREG_SET_ORDER | PREG_OFFSET_CAPTURE,
        )) {
            return $ranges;
        }

        foreach ($matches as $match) {
            $ranges[] = [
                'offset' => $match[1][1],
                'length' => strlen($match[1][0]),
            ];
        }

        return $ranges;
    }

    /** @param list<array{offset: int, length: int}> $ranges */
    public static function overlaps(int $offset, int $length, array $ranges): bool
    {
        foreach ($ranges as $range) {
            if ($offset < $range['offset'] + $range['length']
                && $offset + $length > $range['offset']) {
                return true;
            }
        }

        return false;
    }

    public static function pageReferenceCount(string $source): int
    {
        if (! preg_match_all('/\[\[[^\]]+\]\]/u', $source, $matches, PREG_OFFSET_CAPTURE)) {
            return 0;
        }

        $codeRanges = self::codeRanges($source);
        $componentRanges = self::componentNameRanges($source);
        $count = 0;

        foreach ($matches[0] as $match) {
            $length = strlen($match[0]);

            if (! self::overlaps($match[1], $length, $codeRanges)
                && ! self::overlaps($match[1], $length, $componentRanges)) {
                $count++;
            }
        }

        return $count;
    }
}
