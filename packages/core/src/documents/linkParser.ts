type JsonValue = Record<string, unknown> | unknown[];

/**
 * Linked nodes in TipTap JSON: page mentions plus block reference and embed
 * targets. Links derive from ids only, never titles.
 */
export function extractMentions(content: unknown): { id: string; label: string | null }[] {
    if (Array.isArray(content)) {
        return content.flatMap((item) => extractMentions(item));
    }

    if (content === null || typeof content !== 'object') {
        return [];
    }

    const node = content as Record<string, unknown>;
    const attrs = (node.attrs ?? {}) as Record<string, unknown>;
    const mentions: { id: string; label: string | null }[] = [];

    if (node.type === 'mention' && typeof attrs.id === 'string') {
        mentions.push({ id: attrs.id, label: typeof attrs.label === 'string' ? attrs.label : null });
    }

    if (
        (node.type === 'blockReference' || node.type === 'blockEmbed') &&
        typeof attrs.targetId === 'string'
    ) {
        mentions.push({
            id: attrs.targetId,
            label: typeof attrs.fallback === 'string' ? attrs.fallback : null,
        });
    }

    for (const child of (node.content as JsonValue[] | undefined) ?? []) {
        mentions.push(...extractMentions(child));
    }

    return mentions;
}
