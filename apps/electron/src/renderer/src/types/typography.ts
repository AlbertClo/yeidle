export const FONT_OPTIONS = [
    {
        value: 'instrument-sans',
        label: 'Instrument Sans',
        family: "'Instrument Sans', ui-sans-serif, system-ui, sans-serif",
    },
    {
        value: 'atkinson-hyperlegible',
        label: 'Atkinson Hyperlegible',
        family: "'Atkinson Hyperlegible Next Variable', 'Atkinson Hyperlegible', ui-sans-serif, system-ui, sans-serif",
    },
    {
        value: 'source-serif-4',
        label: 'Source Serif 4',
        family: "'Source Serif 4 Variable', 'Source Serif 4', Georgia, serif",
    },
    {
        value: 'jetbrains-mono',
        label: 'JetBrains Mono',
        family: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    },
] as const;

export type FontFamily = (typeof FONT_OPTIONS)[number]['value'];

export const DEFAULT_FONT_FAMILY: FontFamily = 'instrument-sans';
export const DEFAULT_FONT_SIZE = 16;
export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 22;

const fontValues = new Set<string>(FONT_OPTIONS.map((font) => font.value));

export function isFontFamily(value: unknown): value is FontFamily {
    return typeof value === 'string' && fontValues.has(value);
}

export function isFontSize(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_FONT_SIZE &&
        value <= MAX_FONT_SIZE
    );
}

export function fontFamilyValue(font: FontFamily): string {
    return (
        FONT_OPTIONS.find((option) => option.value === font)?.family ??
        FONT_OPTIONS[0].family
    );
}
