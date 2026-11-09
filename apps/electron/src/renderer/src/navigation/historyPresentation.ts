export type NavigationHistoryLocationBase = {
    id: string;
    parent_id: string | null;
    visited_at: string;
    last_visited_at: string;
};

export type NavigationHistoryRow<T extends NavigationHistoryLocationBase> =
    T & {
        depth: number;
    };

function mostRecentFirst(
    a: NavigationHistoryLocationBase,
    b: NavigationHistoryLocationBase,
): number {
    const lastVisited = b.last_visited_at.localeCompare(a.last_visited_at);

    if (lastVisited !== 0) {
        return lastVisited;
    }

    const firstVisited = b.visited_at.localeCompare(a.visited_at);

    return firstVisited !== 0 ? firstVisited : b.id.localeCompare(a.id);
}

export function navigationHistoryRows<T extends NavigationHistoryLocationBase>(
    locations: T[],
    currentId: string | null,
): NavigationHistoryRow<T>[] {
    const byId = new Map(locations.map((location) => [location.id, location]));
    const children = new Map<string, T[]>();

    for (const location of locations) {
        if (!location.parent_id || !byId.has(location.parent_id)) {
            continue;
        }

        const siblings = children.get(location.parent_id) ?? [];
        siblings.push(location);
        children.set(location.parent_id, siblings);
    }

    for (const siblings of children.values()) {
        siblings.sort(mostRecentFirst);
    }

    const mainPath = new Set<string>();
    let current = currentId ? (byId.get(currentId) ?? null) : null;

    while (current && !mainPath.has(current.id)) {
        mainPath.add(current.id);
        current = current.parent_id
            ? (byId.get(current.parent_id) ?? null)
            : null;
    }

    current = currentId ? (byId.get(currentId) ?? null) : null;

    while (current) {
        const forward = children.get(current.id)?.[0] ?? null;

        if (!forward || mainPath.has(forward.id)) {
            break;
        }

        mainPath.add(forward.id);
        current = forward;
    }

    return locations
        .filter((location) => mainPath.has(location.id))
        .sort(mostRecentFirst)
        .map((location) => ({ ...location, depth: 0 }));
}
