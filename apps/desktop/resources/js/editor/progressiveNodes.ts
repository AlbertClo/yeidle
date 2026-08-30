import type { Node } from '@/types/node';

export function countNodes(nodes: Node[]): number {
    return nodes.reduce(
        (total, node) => total + 1 + countNodes(node.children ?? []),
        0,
    );
}

export function takeNodePrefix(nodes: Node[], limit: number): Node[] {
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
                children: takeLevel(node.children ?? []),
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
): Node[] {
    const flattened: { id: string; ancestors: string[] }[] = [];

    function flatten(level: Node[], ancestors: string[]): void {
        for (const node of level) {
            flattened.push({ id: node.id, ancestors });
            flatten(node.children ?? [], [...ancestors, node.id]);
        }
    }

    flatten(nodes, []);

    const targetIndex = flattened.findIndex(({ id }) => id === targetId);

    if (targetIndex === -1 || limit <= 0) {
        return takeNodePrefix(nodes, limit);
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
