import { placeholders } from '../../db/database';
import type { Database } from '../../db/database';

/** A page (matched by title) or a block (matched by text). */
export type SearchResult = {
    kind: 'page' | 'block';
    id: string;
    page_id: string;
    /** The page's title, or the block's text. */
    text: string;
};

type Candidate = SearchResult & { updated_at: number };

type Score = {
    tier: number;
    distance: number;
    fts_rank: number;
    updated_at: number;
    id: string;
};

const CANDIDATE_LIMIT = 360;
const RESULT_LIMIT = 60;

/**
 * Search over page titles and block text. Blocks come from the FTS5 trigram
 * index (plus LIKE patterns for short queries and typos); page titles are
 * few enough to score every one. Results rank by match tier (pages before
 * blocks at each tier), edit distance, bm25 and recency.
 */
export function search(db: Database, rawQuery: string): SearchResult[] {
    const query = normalize(rawQuery);

    if (query === '') {
        return [];
    }

    const threshold = distanceThreshold(query);
    const scored: { candidate: Candidate; score: Score }[] = [];

    for (const page of db.all<{
        id: string;
        title: string;
        updated_at: number;
    }>('SELECT id, title, updated_at FROM pages')) {
        scored.push({
            candidate: {
                kind: 'page',
                id: page.id,
                page_id: page.id,
                text: page.title,
                updated_at: page.updated_at,
            },
            score: score(page.id, page.title, true, query, 0, page.updated_at),
        });
    }

    const ranks = blockCandidates(db, query);
    const ids = [...ranks.keys()];

    for (const block of ids.length === 0
        ? []
        : db.all<{
              id: string;
              page_id: string;
              text: string;
              updated_at: number;
          }>(
              `SELECT blocks.id, blocks.page_id, blocks.text, pages.updated_at
               FROM blocks INNER JOIN pages ON pages.id = blocks.page_id
               WHERE blocks.id IN (${placeholders(ids.length)})`,
              ids,
          )) {
        scored.push({
            candidate: { kind: 'block', ...block },
            score: score(
                block.id,
                block.text,
                false,
                query,
                ranks.get(block.id)!,
                block.updated_at,
            ),
        });
    }

    return scored
        .filter(({ score }) => score.tier < 6 || score.distance <= threshold)
        .sort((left, right) => compare(left.score, right.score))
        .slice(0, RESULT_LIMIT)
        .map(({ candidate }) => ({
            kind: candidate.kind,
            id: candidate.id,
            page_id: candidate.page_id,
            text: candidate.text,
        }));
}

function blockCandidates(db: Database, query: string): Map<string, number> {
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
        `SELECT blocks.id, bm25(block_search) AS search_rank
        FROM block_search
        INNER JOIN blocks ON blocks.search_id = block_search.rowid
        WHERE block_search MATCH ?
        ORDER BY search_rank
        LIMIT ?`,
        [match, CANDIDATE_LIMIT],
    );

    return new Map(
        rows.map((row) => [String(row.id), Number(row.search_rank)]),
    );
}

/** Blocks whose text matches any pattern, on recently changed pages first. */
function likeBlocks(db: Database, patterns: string[]): string[] {
    return db
        .all<{ id: string }>(
            `SELECT blocks.id FROM blocks
             INNER JOIN pages ON pages.id = blocks.page_id
             WHERE ${patterns.map(() => 'blocks.text LIKE ?').join(' OR ')}
             ORDER BY pages.updated_at DESC, blocks.id DESC
             LIMIT ?`,
            [...patterns, CANDIDATE_LIMIT],
        )
        .map((row) => row.id);
}

function likeCandidates(db: Database, query: string): Map<string, number> {
    return new Map(
        likeBlocks(db, [`%${query}%`]).map((id, index) => [id, index]),
    );
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
            [swapped[index], swapped[index + 1]] = [
                swapped[index + 1],
                swapped[index],
            ];
            patterns.push(`%${swapped.join('')}%`);
        }
    }

    return new Map(
        likeBlocks(db, [...new Set(patterns)]).map((id, index) => [
            id,
            1_000_000 + index,
        ]),
    );
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

function score(
    id: string,
    text: string,
    isPage: boolean,
    query: string,
    ftsRank: number,
    updatedAt: number,
): Score {
    const content = normalize(text);
    let tier: number;

    if (content === query) {
        tier = isPage ? 0 : 1;
    } else if (
        content.startsWith(query) ||
        hasSequentialTokenPrefixMatch(query, content)
    ) {
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
        updated_at: updatedAt,
        id,
    };
}

function words(value: string): string[] {
    return value.split(/\s+/u).filter((word) => word !== '');
}

function hasSequentialTokenPrefixMatch(
    query: string,
    content: string,
): boolean {
    const queryTokens = words(query);
    const contentTokens = words(content);

    if (queryTokens.length === 0 || queryTokens.length > contentTokens.length) {
        return false;
    }

    for (
        let start = 0;
        start <= contentTokens.length - queryTokens.length;
        start++
    ) {
        if (
            queryTokens.every((token, offset) =>
                contentTokens[start + offset].startsWith(token),
            )
        ) {
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
        for (
            let index = 0;
            index <= contentWords.length - windowSize;
            index++
        ) {
            const candidate = contentWords
                .slice(index, index + windowSize)
                .join(' ');
            best = Math.min(
                best,
                normalizedDistance(query, substr(candidate, 160)),
            );

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
            leftCharacters[differences[0]] ===
                rightCharacters[differences[1]] &&
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

    return (
        spaceship(right.updated_at, left.updated_at) ||
        spaceship(right.id, left.id)
    );
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
