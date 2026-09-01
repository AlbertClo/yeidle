import type { Node } from '@/types/node';

export function countNodes(nodes: Node[]): number {
    return nodes.reduce(
        (total, node) => total + 1 + countNodes(node.children ?? []),
        0,
    );
}

export function takeNodePrefix(
    nodes: Node[],
    limit: number,
    collapsedNodeIds: ReadonlySet<string> = new Set(),
): Node[] {
    let remaining = Math.max(0, limit);

    function takeLevel(level: Node[]): Node[] {
        const result: Node[] = [];

        for (const node of level) {
            if (remaining === 0) {
                break;
            }

            remaining -= 1;
            result.push({
                ...node,
                children: collapsedNodeIds.has(node.id)
                    ? []
                    : takeLevel(node.children ?? []),
            });
        }

        return result;
    }

    return takeLevel(nodes);
}

export function takeNodeWindow(
    nodes: Node[],
    targetId: string,
    limit: number,
    collapsedNodeIds: ReadonlySet<string> = new Set(),
): Node[] {
    const flattened: { id: string; ancestors: string[] }[] = [];
    const targetAncestors = findAncestors(nodes, targetId) ?? [];
    const revealedForTarget = new Set(targetAncestors);

    function flatten(level: Node[], ancestors: string[]): void {
        for (const node of level) {
            flattened.push({ id: node.id, ancestors });

            if (
                !collapsedNodeIds.has(node.id) ||
                revealedForTarget.has(node.id)
            ) {
                flatten(node.children ?? [], [...ancestors, node.id]);
            }
        }
    }

    flatten(nodes, []);

    const targetIndex = flattened.findIndex(({ id }) => id === targetId);

    if (targetIndex === -1 || limit <= 0) {
        return takeNodePrefix(nodes, limit, collapsedNodeIds);
    }

    const windowSize = Math.min(limit, flattened.length);
    const start = Math.min(
        Math.max(0, targetIndex - Math.floor(windowSize / 2)),
        flattened.length - windowSize,
    );
    const included = new Set<string>();

    for (const entry of flattened.slice(start, start + windowSize)) {
        included.add(entry.id);
        entry.ancestors.forEach((id) => included.add(id));
    }

    function cloneIncluded(level: Node[]): Node[] {
        return level.flatMap((node) => {
            if (!included.has(node.id)) {
                return [];
            }

            return [
                {
                    ...node,
                    children: cloneIncluded(node.children ?? []),
                },
            ];
        });
    }

    return cloneIncluded(nodes);
}

function findAncestors(
    nodes: Node[],
    targetId: string,
    ancestors: string[] = [],
): string[] | null {
    for (const node of nodes) {
        if (node.id === targetId) {
            return ancestors;
        }

        const found = findAncestors(node.children ?? [], targetId, [
            ...ancestors,
            node.id,
        ]);

        if (found) {
            return found;
        }
    }

    return null;
}
