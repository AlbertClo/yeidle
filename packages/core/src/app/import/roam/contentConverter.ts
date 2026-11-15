import type { RoamImportReport } from './report';
import {
    codeRanges,
    componentNameRanges,
    LINE_BREAK,
    overlaps,
    phpTrim,
} from './syntax';

export type MediaDescriptor = {
    id: string;
    original_name: string;
    mime_type: string;
    size: number;
};

type TiptapNode = Record<string, unknown>;

export type ConvertedContent = {
    content: string;
    tiptap_content: TiptapNode | TiptapNode[];
    is_checked: boolean | null;
};

type Token =
    | {
          type: 'code';
          offset: number;
          length: number;
          raw: string;
          language: string;
          code: string;
      }
    | {
          type: 'embed';
          offset: number;
          length: number;
          raw: string;
          uid: string;
      }
    | {
          type: 'attachment';
          offset: number;
          length: number;
          raw: string;
          url: string;
          label: string;
      };

const CHECKBOX_DONE = /\{\{\s*\[\[DONE\]\]\s*\}\}/i;
const CHECKBOX_TODO = /\{\{\s*\[\[TODO\]\]\s*\}\}/i;
const CHECKBOX = /\{\{\s*\[\[(?:TODO|DONE)\]\]\s*\}\}\s*/gi;

// `^` only after \n (PCRE's multiline default), `\z` as "nothing follows"
const FENCED_CODE = new RegExp(
    `(?:^|(?<=\\n))[ \\t]{0,3}\`\`\`([^\`\\r\\n]*)[ \\t]*${LINE_BREAK}([\\s\\S]*?)` +
        `(?:${LINE_BREAK}[ \\t]{0,3}\`\`\`[ \\t]*(?=${LINE_BREAK}|(?![\\s\\S]))|(?![\\s\\S]))`,
    'g',
);
const EMBED = /\{\{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\(([^)]+)\)\)\s*\}\}/gi;
const IMAGE =
    /!\[([^\]]*)\]\((https:\/\/firebasestorage\.googleapis\.com\/[^\s)>}\]]+)\)/gi;
const FIREBASE_URL =
    /https:\/\/firebasestorage\.googleapis\.com\/[^\s)>}\]]+/gi;
const INLINE =
    /(?<!`)`([^`\r\n]+)`(?!`)|\[\[([^\]]+)\]\]|\(\(([^)]+)\)\)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/\S+)/gi;
const LEADING_BREAK = new RegExp(`^${LINE_BREAK}`);
const TRAILING_BREAK = new RegExp(`${LINE_BREAK}$`);
const LINE_SPLIT = new RegExp(LINE_BREAK);

/**
 * Converts one Roam block string into the editor's TipTap JSON: checkboxes,
 * fenced code, block embeds and Firebase uploads become blocks; inline code,
 * page and block references and links become inline nodes. Anything that
 * can't be resolved is kept as text and counted in the report.
 */
export class RoamContentConverter {
    private warnedPageReferences = new Set<string>();
    private warnedBlockReferences = new Set<string>();
    private lowerTitles: Map<string, string> | null = null;

    constructor(
        private pageIdsByTitle: Map<string, string>,
        private nodeIdsByUid: Map<string, string>,
        private nodeContentByUid: Map<string, string>,
        private mediaByUrl: Map<string, MediaDescriptor>,
        private report: RoamImportReport,
    ) {}

    convert(input: string, heading: number | null = null): ConvertedContent {
        const [source, checked] = this.extractCheckbox(input);
        const blocks: TiptapNode[] = [];
        let cursor = 0;
        let plainContent = '';
        let previousTokenWasCode = false;

        for (const token of this.blockTokens(source)) {
            const before = source.slice(cursor, token.offset);
            plainContent += before;
            let paragraphBefore = before;

            if (previousTokenWasCode) {
                paragraphBefore = paragraphBefore.replace(LEADING_BREAK, '');
            }

            if (token.type === 'code') {
                paragraphBefore = paragraphBefore.replace(TRAILING_BREAK, '');
            }

            this.appendParagraph(blocks, paragraphBefore, heading);
            heading = null;

            if (token.type === 'code') {
                const codeBlock: TiptapNode = {
                    type: 'codeBlock',
                    attrs: {
                        language: token.language !== '' ? token.language : null,
                    },
                };

                if (token.code !== '') {
                    codeBlock.content = [{ type: 'text', text: token.code }];
                }

                blocks.push(codeBlock);
                plainContent += token.raw;
            } else if (token.type === 'embed') {
                const targetId = this.nodeIdsByUid.get(token.uid);

                if (targetId) {
                    blocks.push({
                        type: 'blockEmbed',
                        attrs: {
                            targetId,
                            targetUid: token.uid,
                            fallback: this.fallbackForUid(token.uid),
                        },
                    });
                } else {
                    this.report.unresolvedBlockReferences++;
                    this.warnAboutBlockReference(token.uid);
                    this.appendParagraph(blocks, token.raw, null);
                }

                plainContent += token.raw;
            } else {
                const media = this.mediaByUrl.get(token.url);

                if (media) {
                    blocks.push({
                        type: 'fileNode',
                        attrs: {
                            mediaId: media.id,
                            src: `/api/media/${media.id}`,
                            originalName: media.original_name,
                            mimeType: media.mime_type,
                            size: media.size,
                        },
                    });
                    plainContent += `[${media.original_name}]`;
                } else {
                    const label =
                        token.label !== ''
                            ? token.label
                            : this.nameFromUrl(token.url);
                    blocks.push(
                        this.paragraph(
                            [
                                {
                                    type: 'webLink',
                                    attrs: { href: token.url, label },
                                },
                            ],
                            null,
                        ),
                    );
                    plainContent += token.raw;
                }
            }

            cursor = token.offset + token.length;
            previousTokenWasCode = token.type === 'code';
        }

        let tail = source.slice(cursor);
        plainContent += tail;

        if (previousTokenWasCode) {
            tail = tail.replace(LEADING_BREAK, '');
        }

        this.appendParagraph(blocks, tail, heading);

        if (blocks.length === 0) {
            blocks.push(this.paragraph([], heading));
        }

        return {
            content: plainContent,
            tiptap_content: blocks.length === 1 ? blocks[0] : blocks,
            is_checked: checked,
        };
    }

    private extractCheckbox(source: string): [string, boolean | null] {
        let checked: boolean | null = null;

        if (CHECKBOX_DONE.test(source)) {
            checked = true;
        } else if (CHECKBOX_TODO.test(source)) {
            checked = false;
        }

        return [source.replace(CHECKBOX, ''), checked];
    }

    private blockTokens(source: string): Token[] {
        const tokens: Token[] = [];

        for (const match of source.matchAll(FENCED_CODE)) {
            tokens.push({
                type: 'code',
                offset: match.index,
                length: match[0].length,
                raw: match[0],
                language: phpTrim(match[1]),
                code: match[2],
            });
        }

        for (const match of source.matchAll(EMBED)) {
            tokens.push({
                type: 'embed',
                offset: match.index,
                length: match[0].length,
                raw: match[0],
                uid: match[1],
            });
        }

        for (const match of source.matchAll(IMAGE)) {
            tokens.push({
                type: 'attachment',
                offset: match.index,
                length: match[0].length,
                raw: match[0],
                url: match[2],
                label: match[1],
            });
        }

        for (const match of source.matchAll(FIREBASE_URL)) {
            if (!overlaps(match.index, match[0].length, tokens)) {
                tokens.push({
                    type: 'attachment',
                    offset: match.index,
                    length: match[0].length,
                    raw: match[0],
                    url: match[0],
                    label: '',
                });
            }
        }

        tokens.sort(
            (left, right) =>
                left.offset - right.offset || right.length - left.length,
        );

        const accepted: Token[] = [];

        for (const token of tokens) {
            if (!overlaps(token.offset, token.length, accepted)) {
                accepted.push(token);
            }
        }

        return accepted;
    }

    private appendParagraph(
        blocks: TiptapNode[],
        text: string,
        heading: number | null,
    ): void {
        if (text === '') {
            return;
        }

        const inline = this.inlineContent(text);

        if (inline.length > 0 || phpTrim(text) !== '') {
            blocks.push(this.paragraph(inline, heading));
        }
    }

    private inlineContent(text: string): TiptapNode[] {
        const nodes: TiptapNode[] = [];
        const matches = [...text.matchAll(INLINE)];

        if (matches.length === 0) {
            this.appendText(nodes, text);

            return nodes;
        }

        const code = codeRanges(text);
        const componentNames = componentNameRanges(text);
        let cursor = 0;

        for (const match of matches) {
            const offset = match.index;
            const length = match[0].length;
            this.appendText(nodes, text.slice(cursor, offset));

            if (match[1] !== undefined) {
                nodes.push({
                    type: 'text',
                    text: match[1],
                    marks: [{ type: 'code' }],
                });
            } else if (
                overlaps(offset, length, code) ||
                (match[2] !== undefined &&
                    overlaps(offset, length, componentNames))
            ) {
                this.appendText(nodes, match[0]);
            } else if (match[2] !== undefined) {
                const title = match[2];
                const pageId =
                    this.pageIdsByTitle.get(title) ??
                    this.caseInsensitivePageId(title);

                if (pageId) {
                    nodes.push({
                        type: 'mention',
                        attrs: { id: pageId, label: title },
                    });
                } else {
                    this.report.unresolvedPageReferences++;
                    this.warnAboutPageReference(title);
                    this.appendText(nodes, match[0]);
                }
            } else if (match[3] !== undefined) {
                const uid = match[3];
                const targetId = this.nodeIdsByUid.get(uid);

                if (targetId) {
                    nodes.push({
                        type: 'blockReference',
                        attrs: {
                            targetId,
                            targetUid: uid,
                            fallback: this.fallbackForUid(uid),
                        },
                    });
                } else {
                    this.report.unresolvedBlockReferences++;
                    this.warnAboutBlockReference(uid);
                    this.appendText(nodes, match[0]);
                }
            } else if (match[5] !== undefined) {
                nodes.push({
                    type: 'webLink',
                    attrs: { href: match[5], label: match[4] },
                });
            } else {
                nodes.push({
                    type: 'webLink',
                    attrs: { href: match[6], label: null },
                });
            }

            cursor = offset + length;
        }

        this.appendText(nodes, text.slice(cursor));

        return nodes;
    }

    private appendText(nodes: TiptapNode[], text: string): void {
        text.split(LINE_SPLIT).forEach((part, index) => {
            if (index > 0) {
                nodes.push({ type: 'hardBreak' });
            }

            if (part !== '') {
                nodes.push({ type: 'text', text: part });
            }
        });
    }

    private paragraph(
        content: TiptapNode[],
        heading: number | null,
    ): TiptapNode {
        const isHeading = heading !== null && heading >= 1 && heading <= 3;
        const node: TiptapNode = { type: isHeading ? 'heading' : 'paragraph' };

        if (isHeading) {
            node.attrs = { level: heading };
        }

        if (content.length > 0) {
            node.content = content;
        }

        return node;
    }

    /** The first title (in export order) that matches ignoring case. */
    private caseInsensitivePageId(title: string): string | null {
        if (this.lowerTitles === null) {
            this.lowerTitles = new Map();

            for (const [candidate, id] of this.pageIdsByTitle) {
                const lower = candidate.toLowerCase();

                if (!this.lowerTitles.has(lower)) {
                    this.lowerTitles.set(lower, id);
                }
            }
        }

        return this.lowerTitles.get(title.toLowerCase()) ?? null;
    }

    private fallbackForUid(uid: string): string {
        const content = (this.nodeContentByUid.get(uid) ?? uid).replace(
            CHECKBOX,
            '',
        );

        return strimwidth(content, 180, '…');
    }

    private nameFromUrl(url: string): string {
        const name = basename(rawUrlDecode(urlPath(url)));

        return name !== '' ? name : 'Roam attachment';
    }

    private warnAboutPageReference(title: string): void {
        if (this.warnedPageReferences.has(title)) {
            return;
        }

        this.warnedPageReferences.add(title);
        this.report.warnings.push(
            `Unresolved page reference [[${title}]] was preserved as text.`,
        );
    }

    private warnAboutBlockReference(uid: string): void {
        if (this.warnedBlockReferences.has(uid)) {
            return;
        }

        this.warnedBlockReferences.add(uid);
        this.report.warnings.push(
            `Unresolved block reference ((${uid})) was preserved as text.`,
        );
    }
}

/** The path component as PHP's parse_url returns it (not normalised like URL). */
export function urlPath(url: string): string {
    const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/.exec(url);

    return match ? match[1] : (url.split(/[?#]/)[0] ?? '');
}

/** PHP's rawurldecode: %XX sequences as UTF-8 bytes. */
export function rawUrlDecode(value: string): string {
    if (!value.includes('%')) {
        return value;
    }

    const bytes: number[] = [];
    const encoder = new TextEncoder();

    for (let i = 0; i < value.length; i++) {
        if (
            value[i] === '%' &&
            /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))
        ) {
            bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            const codePoint = value.codePointAt(i)!;
            const char = String.fromCodePoint(codePoint);
            bytes.push(...encoder.encode(char));
            i += char.length - 1;
        }
    }

    return new TextDecoder().decode(new Uint8Array(bytes));
}

/** PHP's basename for `/` separated paths. */
export function basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');

    return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** mb_strimwidth($value, 0, $width, $marker): East Asian wide characters count twice. */
export function strimwidth(
    value: string,
    width: number,
    marker: string,
): string {
    const chars = [...value];
    const widthOf = (char: string) => (isWide(char.codePointAt(0)!) ? 2 : 1);
    const total = chars.reduce((sum, char) => sum + widthOf(char), 0);

    if (total <= width) {
        return value;
    }

    const limit =
        width - [...marker].reduce((sum, char) => sum + widthOf(char), 0);
    let used = 0;
    let result = '';

    for (const char of chars) {
        const w = widthOf(char);

        if (used + w > limit) {
            break;
        }

        used += w;
        result += char;
    }

    return result + marker;
}

function isWide(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe4f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd)
    );
}
