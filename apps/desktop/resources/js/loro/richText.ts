import type { LoroDoc, LoroText } from 'loro-crdt';

/**
 * A block's TipTap content stored as one Loro rich text.
 *
 * The encoding follows the Quill delta convention so concurrent typing merges
 * character by character:
 *
 * - Each top-level textblock contributes its inline characters followed by a
 *   BLOCK_END terminator whose `block` mark describes the block
 *   (`{ type, attrs }`).
 * - A block without inline content (file node, horizontal rule, or any block
 *   that nests other blocks, such as a blockquote) is stored whole as the
 *   `block` mark of a bare terminator (`{ type, attrs, node }`). It merges
 *   last-writer-wins rather than by character.
 * - Inline atoms (mentions, web links, hard breaks) are one OBJECT character
 *   carrying an `inline` mark (`{ type, attrs }`).
 * - Text marks are stored under `m_<type>` with their attrs (or `true`).
 */

export const BLOCK_END = '\u2029';
export const OBJECT = '\ufffc';

export const BLOCK_KEY = 'block';
export const INLINE_KEY = 'inline';
export const MARK_PREFIX = 'm_';

// Marks that should not grow when typing at their edge
const NON_EXPANDING_MARKS = ['link', 'code'];

/** Must run on every LoroDoc before its text is read or edited. */
export function configureTextStyles(doc: LoroDoc): void {
    const styles: Record<string, { expand: 'after' | 'none' }> = {
        [BLOCK_KEY]: { expand: 'none' },
        [INLINE_KEY]: { expand: 'none' },
    };

    for (const mark of NON_EXPANDING_MARKS) {
        styles[MARK_PREFIX + mark] = { expand: 'none' };
    }

    doc.configTextStyle(styles);
    doc.configDefaultTextStyle({ expand: 'after' });
}

export type JsonNode = {
    type: string;
    attrs?: Record<string, unknown>;
    content?: JsonNode[];
    marks?: { type: string; attrs?: Record<string, unknown> }[];
    text?: string;
};

export type TiptapContent = JsonNode | JsonNode[] | null;

export type Attrs = Record<string, unknown>;

/** One code point (or terminator/object) with its marks. */
export type Unit = { ch: string; attrs: Attrs };

type BlockMark = {
    type: string;
    attrs?: Record<string, unknown> | null;
    node?: JsonNode;
};

// Mark order on decode — PageEditor's schema order, unknown marks last
const MARK_ORDER = ['bold', 'italic', 'strike', 'code', 'highlight', 'link'];

function markRank(type: string): number {
    const index = MARK_ORDER.indexOf(type);

    return index === -1 ? MARK_ORDER.length : index;
}

/** Canonical JSON: sorted keys, so equal values compare equal as strings. */
export function canonicalJson(value: unknown): string {
    if (value === undefined) {
        return 'null';
    }

    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }

    const record = value as Record<string, unknown>;

    return `{${Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(',')}}`;
}

export function attrsKey(attrs: Attrs): string {
    return canonicalJson(attrs);
}

function hasAttrs(attrs: Record<string, unknown> | undefined | null): boolean {
    return attrs != null && Object.keys(attrs).length > 0;
}

function isTextblock(node: JsonNode): boolean {
    // A block holding only inline nodes (or nothing yet). Known textblocks are
    // listed so an empty one still encodes as a textblock.
    if (['paragraph', 'heading', 'codeBlock'].includes(node.type)) {
        return true;
    }

    return (
        node.content !== undefined &&
        node.content.length > 0 &&
        node.content.every((child) => isInline(child))
    );
}

const INLINE_TYPES = new Set([
    'text',
    'mention',
    'webLink',
    'hardBreak',
    'blockReference',
]);

function isInline(node: JsonNode): boolean {
    return INLINE_TYPES.has(node.type);
}

function marksToAttrs(
    marks: JsonNode['marks'],
    into: Attrs,
): void {
    for (const mark of marks ?? []) {
        into[MARK_PREFIX + mark.type] = hasAttrs(mark.attrs)
            ? mark.attrs
            : true;
    }
}

function sanitizeText(text: string): string {
    return text.replaceAll(BLOCK_END, '\n').replaceAll(OBJECT, '');
}

/** TipTap content → rich text units. */
export function contentToUnits(content: TiptapContent): Unit[] {
    const blocks = content === null ? [] : Array.isArray(content) ? content : [content];
    const units: Unit[] = [];

    for (const block of blocks) {
        if (!block || typeof block !== 'object') {
            continue;
        }

        if (!isTextblock(block)) {
            units.push({
                ch: BLOCK_END,
                attrs: {
                    [BLOCK_KEY]: {
                        type: block.type,
                        node: block,
                    } satisfies BlockMark,
                },
            });

            continue;
        }

        for (const child of block.content ?? []) {
            if (child.type === 'text') {
                const attrs: Attrs = {};
                marksToAttrs(child.marks, attrs);

                for (const ch of sanitizeText(child.text ?? '')) {
                    units.push({ ch, attrs: { ...attrs } });
                }

                continue;
            }

            const attrs: Attrs = {
                [INLINE_KEY]: {
                    type: child.type,
                    attrs: hasAttrs(child.attrs) ? child.attrs : null,
                },
            };
            marksToAttrs(child.marks, attrs);
            units.push({ ch: OBJECT, attrs });
        }

        units.push({
            ch: BLOCK_END,
            attrs: {
                [BLOCK_KEY]: {
                    type: block.type,
                    attrs: hasAttrs(block.attrs) ? block.attrs : null,
                } satisfies BlockMark,
            },
        });
    }

    return units;
}

function attrsToMarks(attrs: Attrs): JsonNode['marks'] {
    const marks = Object.keys(attrs)
        .filter((key) => key.startsWith(MARK_PREFIX))
        .map((key) => {
            const type = key.slice(MARK_PREFIX.length);
            const value = attrs[key];

            return value !== null && typeof value === 'object'
                ? { type, attrs: value as Record<string, unknown> }
                : { type };
        })
        .sort(
            (a, b) =>
                markRank(a.type) - markRank(b.type) ||
                a.type.localeCompare(b.type),
        );

    return marks.length > 0 ? marks : undefined;
}

function pushInline(content: JsonNode[], unit: Unit): void {
    const marks = attrsToMarks(unit.attrs);
    const inline = unit.attrs[INLINE_KEY] as
        | { type: string; attrs?: Record<string, unknown> | null }
        | undefined;

    if (unit.ch === OBJECT) {
        if (!inline) {
            return;
        }

        const node: JsonNode = { type: inline.type };

        if (hasAttrs(inline.attrs)) {
            node.attrs = inline.attrs!;
        }

        if (marks) {
            node.marks = marks;
        }

        content.push(node);

        return;
    }

    const last = content[content.length - 1];

    if (
        last?.type === 'text' &&
        canonicalJson(last.marks ?? null) === canonicalJson(marks ?? null)
    ) {
        last.text += unit.ch;

        return;
    }

    const node: JsonNode = { type: 'text', text: unit.ch };

    if (marks) {
        node.marks = marks;
    }

    content.push(node);
}

/** Rich text units → TipTap content (one object, or an array of blocks). */
export function unitsToContent(units: Unit[]): TiptapContent {
    const blocks: JsonNode[] = [];
    let inline: JsonNode[] = [];

    const flushOrphanInline = () => {
        // Characters merged in front of a whole-block terminator (concurrent
        // edits around a file node) surface as their own paragraph
        if (inline.length > 0) {
            blocks.push({ type: 'paragraph', content: inline });
            inline = [];
        }
    };

    for (const unit of units) {
        if (unit.ch !== BLOCK_END) {
            pushInline(inline, unit);

            continue;
        }

        const block = unit.attrs[BLOCK_KEY] as BlockMark | undefined;

        if (block?.node) {
            flushOrphanInline();
            blocks.push(block.node);

            continue;
        }

        const node: JsonNode = { type: block?.type ?? 'paragraph' };

        if (hasAttrs(block?.attrs)) {
            node.attrs = block!.attrs!;
        }

        if (inline.length > 0) {
            node.content = inline;
        }

        blocks.push(node);
        inline = [];
    }

    // Trailing characters without a terminator (a concurrent delete of the
    // terminator) still belong to a paragraph
    flushOrphanInline();

    if (blocks.length === 0) {
        return null;
    }

    return blocks.length === 1 ? blocks[0] : blocks;
}

/** Reads the current units of a Loro text. */
export function readUnits(text: LoroText): Unit[] {
    const units: Unit[] = [];

    for (const op of text.toDelta()) {
        if (typeof op.insert !== 'string') {
            continue;
        }

        const attrs = (op.attributes ?? {}) as Attrs;

        for (const ch of op.insert) {
            units.push({ ch, attrs });
        }
    }

    return units;
}

function utf16Length(units: Unit[], from: number, to: number): number {
    let length = 0;

    for (let i = from; i < to; i++) {
        length += units[i].ch.length;
    }

    return length;
}

/**
 * Makes `text` equal `target` with a minimal edit: the common prefix and
 * suffix are kept (only their formatting is corrected), so concurrent edits
 * elsewhere in the block survive the merge.
 *
 * Returns whether anything changed.
 */
export function applyUnits(text: LoroText, target: Unit[]): boolean {
    const current = readUnits(text);

    let prefix = 0;

    while (
        prefix < current.length &&
        prefix < target.length &&
        current[prefix].ch === target[prefix].ch
    ) {
        prefix++;
    }

    let suffix = 0;

    while (
        suffix < current.length - prefix &&
        suffix < target.length - prefix &&
        current[current.length - 1 - suffix].ch ===
            target[target.length - 1 - suffix].ch
    ) {
        suffix++;
    }

    let changed = false;
    const deleteFrom = utf16Length(current, 0, prefix);
    const deleteLength = utf16Length(current, prefix, current.length - suffix);

    if (deleteLength > 0) {
        text.delete(deleteFrom, deleteLength);
        changed = true;
    }

    const inserted = target.slice(prefix, target.length - suffix);

    if (inserted.length > 0) {
        text.insert(deleteFrom, inserted.map((unit) => unit.ch).join(''));
        changed = true;
    }

    // Formatting pass over the whole result: inserted characters may have
    // inherited marks from their neighbours, and kept characters may need
    // marks added or removed
    if (formatUnits(text, target)) {
        changed = true;
    }

    return changed;
}

function formatUnits(text: LoroText, target: Unit[]): boolean {
    const current = readUnits(text);

    if (current.length !== target.length) {
        throw new Error('Rich text length mismatch while formatting.');
    }

    let changed = false;
    let offset = 0;
    let i = 0;

    while (i < target.length) {
        const have = current[i].attrs;
        const want = target[i].attrs;

        if (attrsKey(have) === attrsKey(want)) {
            offset += target[i].ch.length;
            i++;

            continue;
        }

        // Extend over the run of characters needing the same correction
        let j = i + 1;
        let end = offset + target[i].ch.length;

        while (
            j < target.length &&
            attrsKey(current[j].attrs) === attrsKey(have) &&
            attrsKey(target[j].attrs) === attrsKey(want)
        ) {
            end += target[j].ch.length;
            j++;
        }

        for (const key of Object.keys(have)) {
            if (!(key in want)) {
                text.unmark({ start: offset, end }, key);
            }
        }

        for (const [key, value] of Object.entries(want)) {
            if (canonicalJson(have[key]) !== canonicalJson(value)) {
                text.mark({ start: offset, end }, key, value);
            }
        }

        changed = true;
        offset = end;
        i = j;
    }

    return changed;
}

export function unitsEqual(a: Unit[], b: Unit[]): boolean {
    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i].ch !== b[i].ch || attrsKey(a[i].attrs) !== attrsKey(b[i].attrs)) {
            return false;
        }
    }

    return true;
}
