/**
 * Roam markup helpers shared by the export analysis and the content
 * converter. The patterns are translations of the PHP importer's PCRE
 * patterns; offsets are string indices rather than byte offsets, which is
 * equivalent because they are only compared with each other.
 */

export type Range = { offset: number; length: number };

/** PCRE's `\R` (any Unicode line break). */
export const LINE_BREAK = '(?:\\r\\n|[\\n\\v\\f\\r\\x85\\u2028\\u2029])';

/** PHP's trim(): only ASCII whitespace and NUL, unlike String.prototype.trim. */
export function phpTrim(value: string): string {
    return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

const FENCED_CODE = /```[\s\S]*?(?:```|(?![\s\S]))/g;
const INLINE_CODE = /(?<!`)`[^`\r\n]*`(?!`)/g;
const COMPONENT_NAME = /\{\{\s*(\[\[[^\]]+\]\])/dg;
const PAGE_REFERENCE = /\[\[[^\]]+\]\]/g;

export function codeRanges(source: string): Range[] {
    const ranges: Range[] = [];

    for (const pattern of [FENCED_CODE, INLINE_CODE]) {
        for (const match of source.matchAll(pattern)) {
            ranges.push({ offset: match.index, length: match[0].length });
        }
    }

    return ranges;
}

/** The `[[name]]` part of `{{[[video]]: ...}}` components. */
export function componentNameRanges(source: string): Range[] {
    const ranges: Range[] = [];

    for (const match of source.matchAll(COMPONENT_NAME)) {
        const [start, end] = match.indices![1]!;
        ranges.push({ offset: start, length: end - start });
    }

    return ranges;
}

export function overlaps(
    offset: number,
    length: number,
    ranges: Range[],
): boolean {
    return ranges.some(
        (range) =>
            offset < range.offset + range.length &&
            offset + length > range.offset,
    );
}

export function pageReferenceCount(source: string): number {
    const matches = [...source.matchAll(PAGE_REFERENCE)];

    if (matches.length === 0) {
        return 0;
    }

    const code = codeRanges(source);
    const components = componentNameRanges(source);

    return matches.filter(
        (match) =>
            !overlaps(match.index, match[0].length, code) &&
            !overlaps(match.index, match[0].length, components),
    ).length;
}
