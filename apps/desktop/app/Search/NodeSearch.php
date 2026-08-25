<?php

namespace App\Search;

use App\Models\Node;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

final class NodeSearch
{
    private const CANDIDATE_LIMIT = 360;

    private const RESULT_LIMIT = 60;

    /** @return Collection<int, Node> */
    public function search(string $query): Collection
    {
        $query = $this->normalize($query);

        if ($query === '') {
            return collect();
        }

        $candidateRanks = $this->candidateRanks($query);

        if ($candidateRanks === []) {
            return collect();
        }

        $nodes = Node::query()
            ->whereKey(array_keys($candidateRanks))
            ->get();

        $nodes = $this->reachableNodes($nodes);

        return $nodes
            ->map(fn (Node $node): array => [
                'node' => $node,
                'score' => $this->score($node, $query, $candidateRanks[$node->id]),
            ])
            ->filter(fn (array $result): bool => $result['score']['tier'] < 6
                || $result['score']['distance'] <= $this->distanceThreshold($query))
            ->sort(fn (array $left, array $right): int => $this->compare($left, $right))
            ->take(self::RESULT_LIMIT)
            ->pluck('node')
            ->values();
    }

    /** @return array<string, float> */
    private function candidateRanks(string $query): array
    {
        if (mb_strlen($query) < 3) {
            return $this->likeCandidates($query);
        }

        $ranks = $this->ftsCandidates($this->quoteFts($query));
        $trigrams = $this->trigrams($query);

        if ($trigrams !== []) {
            $fuzzy = $this->ftsCandidates(
                implode(' OR ', array_map($this->quoteFts(...), $trigrams)),
            );

            foreach ($fuzzy as $id => $rank) {
                $ranks[$id] = min($ranks[$id] ?? INF, $rank);
            }
        }

        if (mb_strlen($query) <= 4) {
            foreach ($this->shortTypoCandidates($query) as $id => $rank) {
                $ranks[$id] = min($ranks[$id] ?? INF, $rank);
            }
        }

        return array_slice($ranks, 0, self::CANDIDATE_LIMIT, true);
    }

    /** @return array<string, float> */
    private function ftsCandidates(string $match): array
    {
        $rows = DB::select(<<<'SQL'
            SELECT nodes.id, bm25(node_search) AS search_rank
            FROM node_search
            INNER JOIN nodes ON nodes.rowid = node_search.rowid
            WHERE node_search MATCH ?
            ORDER BY search_rank
            LIMIT ?
        SQL, [$match, self::CANDIDATE_LIMIT]);

        $ranks = [];
        foreach ($rows as $row) {
            $ranks[(string) $row->id] = (float) $row->search_rank;
        }

        return $ranks;
    }

    /** @return array<string, float> */
    private function likeCandidates(string $query): array
    {
        return Node::query()
            ->where('content', 'like', '%'.$query.'%')
            ->orderedByModification()
            ->limit(self::CANDIDATE_LIMIT)
            ->pluck('id')
            ->mapWithKeys(fn (string $id, int $index): array => [$id => (float) $index])
            ->all();
    }

    /** @return array<string, float> */
    private function shortTypoCandidates(string $query): array
    {
        $characters = mb_str_split($query);
        $patterns = [];

        for ($index = 0; $index < count($characters); $index++) {
            $prefix = implode('', array_slice($characters, 0, $index));
            $suffix = implode('', array_slice($characters, $index + 1));
            $patterns[] = '%'.$prefix.'_'.$suffix.'%';
            $patterns[] = '%'.$prefix.'_'.$characters[$index].$suffix.'%';

            if (count($characters) > 3) {
                $patterns[] = '%'.$prefix.$suffix.'%';
            }

            if (isset($characters[$index + 1])) {
                $swapped = $characters;
                [$swapped[$index], $swapped[$index + 1]] = [$swapped[$index + 1], $swapped[$index]];
                $patterns[] = '%'.implode('', $swapped).'%';
            }
        }

        $patterns = array_values(array_unique($patterns));

        return Node::query()
            ->where(function ($builder) use ($patterns): void {
                foreach ($patterns as $pattern) {
                    $builder->orWhere('content', 'like', $pattern);
                }
            })
            ->orderedByModification()
            ->limit(self::CANDIDATE_LIMIT)
            ->pluck('id')
            ->mapWithKeys(fn (string $id, int $index): array => [$id => 1_000_000.0 + $index])
            ->all();
    }

    /** @return list<string> */
    private function trigrams(string $query): array
    {
        $characters = mb_str_split($query);
        $trigrams = [];

        for ($index = 0; $index <= count($characters) - 3; $index++) {
            $trigram = implode('', array_slice($characters, $index, 3));

            if (trim($trigram) !== '') {
                $trigrams[$trigram] = true;
            }
        }

        return array_slice(array_keys($trigrams), 0, 64);
    }

    /**
     * Resolve all candidate parent chains in batches instead of running one
     * query per ancestor through Node::isReachable().
     *
     * @param  Collection<int, Node>  $nodes
     * @return Collection<int, Node>
     */
    private function reachableNodes(Collection $nodes): Collection
    {
        $known = $nodes->keyBy('id');
        $missing = [];

        while (true) {
            $parentIds = $known
                ->pluck('parent_id')
                ->filter()
                ->reject(fn (string $id): bool => $known->has($id) || isset($missing[$id]))
                ->unique()
                ->values();

            if ($parentIds->isEmpty()) {
                break;
            }

            $parents = Node::withTrashed()->whereKey($parentIds)->get();
            $found = $parents->keyBy('id');

            foreach ($parentIds as $parentId) {
                if (! $found->has($parentId)) {
                    $missing[$parentId] = true;
                }
            }

            foreach ($parents as $parent) {
                $known->put($parent->id, $parent);
            }
        }

        return $nodes->filter(function (Node $node) use ($known): bool {
            $visited = [];
            $current = $node;

            while (true) {
                if ($current->purged || $current->trashed()) {
                    return false;
                }

                if ($current->parent_id === null) {
                    return true;
                }

                if (isset($visited[$current->id])) {
                    return false;
                }

                $visited[$current->id] = true;
                $current = $known->get($current->parent_id);

                if (! $current) {
                    return false;
                }
            }
        });
    }

    /**
     * @return array{tier: int, distance: float, fts_rank: float, modified_hlc: string, id: string}
     */
    private function score(Node $node, string $query, float $ftsRank): array
    {
        $content = $this->normalize($node->content);
        $isPage = $node->parent_id === null;

        if ($content === $query) {
            $tier = $isPage ? 0 : 1;
        } elseif (str_starts_with($content, $query)
            || $this->hasSequentialTokenPrefixMatch($query, $content)) {
            $tier = $isPage ? 2 : 3;
        } elseif (str_contains($content, $query)) {
            $tier = $isPage ? 4 : 5;
        } else {
            $tier = $isPage ? 6 : 7;
        }

        return [
            'tier' => $tier,
            'distance' => $tier < 6 ? 0.0 : $this->bestDistance($query, $content),
            'fts_rank' => $ftsRank,
            'modified_hlc' => $node->modified_hlc,
            'id' => $node->id,
        ];
    }

    private function hasSequentialTokenPrefixMatch(string $query, string $content): bool
    {
        $queryTokens = preg_split('/\s+/u', $query, flags: PREG_SPLIT_NO_EMPTY) ?: [];
        $contentTokens = preg_split('/\s+/u', $content, flags: PREG_SPLIT_NO_EMPTY) ?: [];
        $queryTokenCount = count($queryTokens);

        if ($queryTokenCount === 0 || $queryTokenCount > count($contentTokens)) {
            return false;
        }

        for ($start = 0; $start <= count($contentTokens) - $queryTokenCount; $start++) {
            foreach ($queryTokens as $offset => $queryToken) {
                if (! str_starts_with($contentTokens[$start + $offset], $queryToken)) {
                    continue 2;
                }
            }

            return true;
        }

        return false;
    }

    private function bestDistance(string $query, string $content): float
    {
        $queryWords = preg_split('/\s+/u', $query, flags: PREG_SPLIT_NO_EMPTY) ?: [];
        $contentWords = preg_split('/\s+/u', $content, flags: PREG_SPLIT_NO_EMPTY) ?: [];
        $windowSizes = array_unique(array_filter([
            max(1, count($queryWords) - 1),
            max(1, count($queryWords)),
            max(1, count($queryWords) + 1),
        ]));
        $best = $this->normalizedDistance($query, mb_substr($content, 0, 160));
        $contentWords = array_slice($contentWords, 0, 400);

        foreach ($windowSizes as $windowSize) {
            for ($index = 0; $index <= count($contentWords) - $windowSize; $index++) {
                $candidate = implode(' ', array_slice($contentWords, $index, $windowSize));
                $best = min($best, $this->normalizedDistance($query, mb_substr($candidate, 0, 160)));

                if ($best === 0.0) {
                    return 0.0;
                }
            }
        }

        return $best;
    }

    private function normalizedDistance(string $left, string $right): float
    {
        $length = max(strlen($left), strlen($right), 1);
        $distance = levenshtein($left, $right);
        $leftCharacters = mb_str_split($left);
        $rightCharacters = mb_str_split($right);

        if (count($leftCharacters) === count($rightCharacters)) {
            $differences = [];

            foreach ($leftCharacters as $index => $character) {
                if ($character !== $rightCharacters[$index]) {
                    $differences[] = $index;
                }
            }

            if (count($differences) === 2
                && $differences[1] === $differences[0] + 1
                && $leftCharacters[$differences[0]] === $rightCharacters[$differences[1]]
                && $leftCharacters[$differences[1]] === $rightCharacters[$differences[0]]) {
                $distance = min($distance, 1);
            }
        }

        return $distance / $length;
    }

    private function distanceThreshold(string $query): float
    {
        return match (true) {
            mb_strlen($query) <= 4 => 0.34,
            mb_strlen($query) <= 8 => 0.4,
            default => 0.45,
        };
    }

    private function compare(array $left, array $right): int
    {
        foreach (['tier', 'distance', 'fts_rank'] as $field) {
            $comparison = $left['score'][$field] <=> $right['score'][$field];

            if ($comparison !== 0) {
                return $comparison;
            }
        }

        $modifiedComparison = $right['score']['modified_hlc'] <=> $left['score']['modified_hlc'];

        return $modifiedComparison !== 0
            ? $modifiedComparison
            : $right['score']['id'] <=> $left['score']['id'];
    }

    private function normalize(string $value): string
    {
        $value = mb_strtolower(trim($value));
        $value = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? $value;

        return trim(preg_replace('/\s+/u', ' ', $value) ?? $value);
    }

    private function quoteFts(string $value): string
    {
        return '"'.str_replace('"', '""', $value).'"';
    }
}
