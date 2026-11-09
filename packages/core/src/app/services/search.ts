import { placeholders } from '../../db/database';
import type { Database } from '../../db/database';
import { serializeNode, SystemNodes } from '../nodes';
import type { NodeJson, NodeRow } from '../nodes';

export type SearchResult = NodeJson & { page_id: string };

type Score = { tier: number; distance: number; fts_rank: number; modified_hlc: string; id: string };

const CANDIDATE_LIMIT = 360;
const RESULT_LIMIT = 60;
const ORDERED_BY_MODIFICATION = 'ORDER BY modified_hlc DESC, id DESC';

/**
 * Node search over the FTS5 trigram index: exact and trigram candidates (plus
 * LIKE patterns for short queries and typos), filtered to reachable nodes and
 * ranked by match tier, edit distance, bm25 and recency.
 */
export function searchNodes(db: Database, rawQuery: string): SearchResult[] {
    const query = normalize(rawQuery);

    if (query === '') {
        return [];
    }

    const candidateRanks = candidates(db, query);

    if (candidateRanks.size === 0) {
        return [];
    }

    const ids = [...candidateRanks.keys()];
    const nodes = db.all<NodeRow>(
        `SELECT * FROM nodes WHERE id IN (${placeholders(ids.length)}) AND deleted_at IS NULL`,
        ids,
    );
    const threshold = distanceThreshold(query);

    return reachableNodes(db, nodes)
        .map(({ node, pageId }) => ({
            node,
            pageId,
            score: score(node, query, candidateRanks.get(node.id)!),
        }))
        .filter((result) => result.score.tier < 6 || result.score.distance <= threshold)
        .sort((left, right) => compare(left.score, right.score))
        .slice(0, RESULT_LIMIT)
        .map(({ node, pageId }) => ({ ...serializeNode(node), page_id: pageId }));
}

function candidates(db: Database, query: string): Map<string, number> {
    if (length(query) < 3) {
        return likeCandidates(db, query);
    }

    const ranks = ftsCandidates(db, quoteFts(query));
    const queryTrigrams = trigrams(query);

    const merge = (more: Map<string, number>) => {
        for (const [id, rank] of more) {
            ranks.set(id, Math.min(ranks.get(id) ?? Infinity, rank));
        }
    };

    if (queryTrigrams.length > 0) {
        merge(ftsCandidates(db, queryTrigrams.map(quoteFts).join(' OR ')));
    }

    if (length(query) <= 4) {
        merge(shortTypoCandidates(db, query));
    }

    return new Map([...ranks].slice(0, CANDIDATE_LIMIT));
}

function ftsCandidates(db: Database, match: string): Map<string, number> {
    const rows = db.all<{ id: string; search_rank: number }>(
        `SELECT nodes.id, bm25(node_search) AS search_rank
        FROM node_search
        INNER JOIN nodes ON nodes.rowid = node_search.rowid
        WHERE node_search MATCH ?
        ORDER BY search_rank
        LIMIT ?`,
        [match, CANDIDATE_LIMIT],
    );

    return new Map(rows.map((row) => [String(row.id), Number(row.search_rank)]));
}

function likeCandidates(db: Database, query: string): Map<string, number> {
    const rows = db.all<{ id: string }>(
        `SELECT id FROM nodes WHERE content LIKE ? AND deleted_at IS NULL ${ORDERED_BY_MODIFICATION} LIMIT ?`,
        [`%${query}%`, CANDIDATE_LIMIT],
    );

    return new Map(rows.map((row, index) => [row.id, index]));
}

function shortTypoCandidates(db: Database, query: string): Map<string, number> {
    const characters = Array.from(query);
    const patterns: string[] = [];

    for (let index = 0; index < characters.length; index++) {
        const prefix = characters.slice(0, index).join('');
        const suffix = characters.slice(index + 1).join('');
        patterns.push(`%${prefix}_${suffix}%`);
        patterns.push(`%${prefix}_${characters[index]}${suffix}%`);

        if (characters.length > 3) {
            patterns.push(`%${prefix}${suffix}%`);
        }

        if (index + 1 < characters.length) {
            const swapped = [...characters];
            [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
            patterns.push(`%${swapped.join('')}%`);
        }
    }

    const unique = [...new Set(patterns)];
    const rows = db.all<{ id: string }>(
        `SELECT id FROM nodes WHERE (${unique.map(() => 'content LIKE ?').join(' OR ')}) AND deleted_at IS NULL ${ORDERED_BY_MODIFICATION} LIMIT ?`,
        [...unique, CANDIDATE_LIMIT],
    );

    return new Map(rows.map((row, index) => [row.id, 1_000_000 + index]));
}

function trigrams(query: string): string[] {
    const characters = Array.from(query);
    const found = new Set<string>();

    for (let index = 0; index <= characters.length - 3; index++) {
        const trigram = characters.slice(index, index + 3).join('');

        if (phpTrim(trigram) !== '') {
            found.add(trigram);
        }
    }

    return [...found].slice(0, 64);
}

/**
 * Resolves all candidate parent chains in batches instead of one query per
 * ancestor, keeping nodes whose chain reaches a live, non-system page.
 */
function reachableNodes(db: Database, nodes: NodeRow[]): { node: NodeRow; pageId: string }[] {
    const known = new Map<string, NodeRow>(nodes.map((node) => [node.id, node]));
    const missing = new Set<string>();

    while (true) {
        const parentIds = [
            ...new Set(
                [...known.values()]
                    .map((node) => node.parent_id)
                    .filter((id): id is string => !!id && !known.has(id) && !missing.has(id)),
            ),
        ];

        if (parentIds.length === 0) {
            break;
        }

        const parents = db.all<NodeRow>(
            `SELECT * FROM nodes WHERE id IN (${placeholders(parentIds.length)})`,
            parentIds,
        );
        const found = new Set(parents.map((parent) => parent.id));

        for (const parentId of parentIds) {
            if (!found.has(parentId)) {
                missing.add(parentId);
            }
        }

        for (const parent of parents) {
            known.set(parent.id, parent);
        }
    }

    const reachable: { node: NodeRow; pageId: string }[] = [];

    for (const node of nodes) {
        const visited = new Set<string>();
        let current: NodeRow | undefined = node;

        while (current) {
            if (SystemNodes.isRoot(current.id) || current.purged || current.deleted_at !== null) {
                break;
            }

            if (current.parent_id === null) {
                reachable.push({ node, pageId: current.id });

                break;
            }

            if (visited.has(current.id)) {
                break;
            }

            visited.add(current.id);
            current = known.get(current.parent_id);
        }
    }

    return reachable;
}

function score(node: NodeRow, query: string, ftsRank: number): Score {
    const content = normalize(node.content);
    const isPage = node.parent_id === null;
    let tier: number;

    if (content === query) {
        tier = isPage ? 0 : 1;
    } else if (content.startsWith(query) || hasSequentialTokenPrefixMatch(query, content)) {
        tier = isPage ? 2 : 3;
    } else if (content.includes(query)) {
        tier = isPage ? 4 : 5;
    } else {
        tier = isPage ? 6 : 7;
    }

    return {
        tier,
        distance: tier < 6 ? 0 : bestDistance(query, content),
        fts_rank: ftsRank,
        modified_hlc: node.modified_hlc,
        id: node.id,
    };
}

function words(value: string): string[] {
    return value.split(/\s+/u).filter((word) => word !== '');
}

function hasSequentialTokenPrefixMatch(query: string, content: string): boolean {
    const queryTokens = words(query);
    const contentTokens = words(content);

    if (queryTokens.length === 0 || queryTokens.length > contentTokens.length) {
        return false;
    }

    for (let start = 0; start <= contentTokens.length - queryTokens.length; start++) {
        if (queryTokens.every((token, offset) => contentTokens[start + offset].startsWith(token))) {
            return true;
        }
    }

    return false;
}

function bestDistance(query: string, content: string): number {
    const queryWords = words(query);
    const contentWords = words(content).slice(0, 400);
    const windowSizes = [
        ...new Set([
            Math.max(1, queryWords.length - 1),
            Math.max(1, queryWords.length),
            Math.max(1, queryWords.length + 1),
        ]),
    ];
    let best = normalizedDistance(query, substr(content, 160));

    for (const windowSize of windowSizes) {
        for (let index = 0; index <= contentWords.length - windowSize; index++) {
            const candidate = contentWords.slice(index, index + windowSize).join(' ');
            best = Math.min(best, normalizedDistance(query, substr(candidate, 160)));

            if (best === 0) {
                return 0;
            }
        }
    }

    return best;
}

const encoder = new TextEncoder();

// PHP's levenshtein() and strlen() work on bytes; keep that for identical scores
function normalizedDistance(left: string, right: string): number {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    const longest = Math.max(leftBytes.length, rightBytes.length, 1);
    let distance = levenshtein(leftBytes, rightBytes);
    const leftCharacters = Array.from(left);
    const rightCharacters = Array.from(right);

    if (leftCharacters.length === rightCharacters.length) {
        const differences: number[] = [];

        leftCharacters.forEach((character, index) => {
            if (character !== rightCharacters[index]) {
                differences.push(index);
            }
        });

        if (
            differences.length === 2 &&
            differences[1] === differences[0] + 1 &&
            leftCharacters[differences[0]] === rightCharacters[differences[1]] &&
            leftCharacters[differences[1]] === rightCharacters[differences[0]]
        ) {
            distance = Math.min(distance, 1);
        }
    }

    return distance / longest;
}

function levenshtein(left: Uint8Array, right: Uint8Array): number {
    if (left.length === 0) {
        return right.length;
    }

    if (right.length === 0) {
        return left.length;
    }

    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);

    for (let i = 0; i < left.length; i++) {
        const current = [i + 1];

        for (let j = 0; j < right.length; j++) {
            current[j + 1] = Math.min(
                previous[j] + (left[i] === right[j] ? 0 : 1),
                previous[j + 1] + 1,
                current[j] + 1,
            );
        }

        previous = current;
    }

    return previous[right.length];
}

function distanceThreshold(query: string): number {
    const size = length(query);

    return size <= 4 ? 0.34 : size <= 8 ? 0.4 : 0.45;
}

function spaceship(left: number | string, right: number | string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function compare(left: Score, right: Score): number {
    for (const field of ['tier', 'distance', 'fts_rank'] as const) {
        const comparison = spaceship(left[field], right[field]);

        if (comparison !== 0) {
            return comparison;
        }
    }

    return spaceship(right.modified_hlc, left.modified_hlc) || spaceship(right.id, left.id);
}

function normalize(value: string): string {
    return phpTrim(value)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function phpTrim(value: string): string {
    return value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, '');
}

function quoteFts(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

/** Length in code points, like mb_strlen. */
function length(value: string): number {
    return Array.from(value).length;
}

function substr(value: string, max: number): string {
    return Array.from(value).slice(0, max).join('');
}
