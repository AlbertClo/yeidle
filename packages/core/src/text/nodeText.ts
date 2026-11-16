type JsonRecord = Record<string, unknown>;

/**
 * Plain text of one TipTap JSON node, as stored in nodes.content (search,
 * page titles in links). Atoms render as their Roam-style source.
 */
export function extractText(node: JsonRecord): string {
    if (node.text) {
        return node.text as string;
    }

    const a = node.attrs as JsonRecord | undefined;

    if (node.type === 'mention') {
        return `[[${a?.label ?? a?.id ?? ''}]]`;
    }

    if (node.type === 'blockReference') {
        return `((${a?.fallback ?? a?.targetUid ?? ''}))`;
    }

    if (node.type === 'blockEmbed') {
        return `{{embed: ((${a?.fallback ?? a?.targetUid ?? ''}))}}`;
    }

    if (node.type === 'webLink') {
        return String(a?.label || a?.href || '');
    }

    if (node.type === 'fileNode') {
        return `[${a?.originalName ?? 'File'}]`;
    }

    const children = (node.content as JsonRecord[]) ?? [];

    return children.map(extractText).join('');
}

/** Plain text of a block's content blocks, joined with spaces. */
export function blocksPlainText(blocks: JsonRecord[]): string {
    return blocks.map(extractText).join(' ');
}
