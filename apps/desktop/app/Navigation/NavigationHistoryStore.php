<?php

namespace App\Navigation;

use App\Accounts\CloudAccountStore;
use App\Models\SyncState;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

final class NavigationHistoryStore
{
    public const MAX_LOCATIONS = 500;

    public function __construct(
        private readonly CloudAccountStore $cloudAccount,
    ) {}

    /** @return array{locations: list<array<string, mixed>>, current_id: ?string} */
    public function get(): array
    {
        $profileKey = $this->profileKey();
        $locations = DB::table('navigation_locations')
            ->leftJoin('nodes as page_nodes', 'navigation_locations.page_id', '=', 'page_nodes.id')
            ->leftJoin('nodes as block_nodes', 'navigation_locations.block_id', '=', 'block_nodes.id')
            ->where('navigation_locations.profile_key', $this->profileKey())
            ->select([
                'navigation_locations.*',
                'page_nodes.content as page_title',
                'block_nodes.content as node_text',
            ])
            ->orderBy('navigation_locations.visited_at')
            ->get()
            ->map(fn (object $location): array => $this->serialize($location))
            ->values()
            ->all();
        $currentId = DB::table('navigation_history_states')
            ->where('profile_key', $profileKey)
            ->value('current_location_id');

        if (! collect($locations)->contains('id', $currentId)) {
            $currentId = null;
        }

        return [
            'locations' => $locations,
            'current_id' => is_string($currentId) ? $currentId : null,
        ];
    }

    /**
     * @param  array<string, mixed>  $location
     * @return array<string, mixed>
     */
    public function save(string $id, array $location, bool $makeCurrent): array
    {
        $profileKey = $this->profileKey();
        $parentId = $location['parent_id'] ?? null;

        if ($parentId !== null && ! DB::table('navigation_locations')
            ->where('id', $parentId)
            ->where('profile_key', $profileKey)
            ->exists()) {
            throw ValidationException::withMessages([
                'parent_id' => 'The parent navigation location does not exist.',
            ]);
        }

        $now = now();
        $row = [
            'id' => $id,
            'profile_key' => $profileKey,
            'parent_id' => $parentId,
            'url' => $location['url'],
            'page_id' => $location['page_id'] ?? null,
            'block_id' => $location['block_id'] ?? null,
            'cursor_offset' => $location['cursor_offset'] ?? null,
            'selection_type' => $location['selection_type'] ?? null,
            'scroll_top' => $location['scroll_top'],
            'visited_at' => CarbonImmutable::parse($location['visited_at']),
            'last_visited_at' => CarbonImmutable::parse($location['last_visited_at']),
            'created_at' => $now,
            'updated_at' => $now,
        ];

        DB::transaction(function () use ($id, $profileKey, $row, $makeCurrent, $now): void {
            DB::table('navigation_locations')->upsert(
                [$row],
                ['id'],
                [
                    'parent_id',
                    'url',
                    'page_id',
                    'block_id',
                    'cursor_offset',
                    'selection_type',
                    'scroll_top',
                    'last_visited_at',
                    'updated_at',
                ],
            );

            if ($makeCurrent) {
                DB::table('navigation_history_states')->updateOrInsert(
                    ['profile_key' => $profileKey],
                    [
                        'current_location_id' => $id,
                        'created_at' => $now,
                        'updated_at' => $now,
                    ],
                );
            }
        });

        $this->prune($profileKey);

        return $this->serialize((object) $row);
    }

    public function setCurrent(string $id): void
    {
        $profileKey = $this->profileKey();

        if (! DB::table('navigation_locations')
            ->where('id', $id)
            ->where('profile_key', $profileKey)
            ->exists()) {
            throw ValidationException::withMessages([
                'id' => 'The navigation location does not exist.',
            ]);
        }

        $now = now();

        DB::transaction(function () use ($id, $profileKey, $now): void {
            DB::table('navigation_locations')
                ->where('id', $id)
                ->where('profile_key', $profileKey)
                ->update(['last_visited_at' => $now, 'updated_at' => $now]);

            DB::table('navigation_history_states')->updateOrInsert(
                ['profile_key' => $profileKey],
                [
                    'current_location_id' => $id,
                    'created_at' => $now,
                    'updated_at' => $now,
                ],
            );
        });
    }

    public function clear(): void
    {
        $profileKey = $this->profileKey();

        DB::transaction(function () use ($profileKey): void {
            DB::table('navigation_history_states')
                ->where('profile_key', $profileKey)
                ->delete();
            DB::table('navigation_locations')
                ->where('profile_key', $profileKey)
                ->delete();
        });
    }

    private function prune(string $profileKey): void
    {
        $locations = DB::table('navigation_locations')
            ->where('profile_key', $profileKey)
            ->get(['id', 'parent_id', 'last_visited_at']);

        if ($locations->count() <= self::MAX_LOCATIONS) {
            return;
        }

        $currentId = DB::table('navigation_history_states')
            ->where('profile_key', $profileKey)
            ->value('current_location_id');
        $protected = $this->ancestorIds($locations, is_string($currentId) ? $currentId : null);
        $remaining = $locations->keyBy('id');
        $remove = [];

        while ($remaining->count() > self::MAX_LOCATIONS) {
            $parentIds = $remaining->pluck('parent_id')->filter()->flip();
            $leaf = $remaining
                ->reject(fn (object $location): bool => isset($protected[$location->id]) || $parentIds->has($location->id))
                ->sortBy('last_visited_at')
                ->first();

            if ($leaf === null) {
                break;
            }

            $remove[] = $leaf->id;
            $remaining->forget($leaf->id);
        }

        if ($remove !== []) {
            DB::table('navigation_locations')
                ->where('profile_key', $profileKey)
                ->whereIn('id', $remove)
                ->delete();
        }
    }

    /** @param Collection<int, object> $locations
     * @return array<string, true>
     */
    private function ancestorIds(Collection $locations, ?string $currentId): array
    {
        $byId = $locations->keyBy('id');
        $ids = [];

        while ($currentId !== null && $byId->has($currentId) && ! isset($ids[$currentId])) {
            $ids[$currentId] = true;
            $parentId = $byId->get($currentId)->parent_id;
            $currentId = is_string($parentId) ? $parentId : null;
        }

        return $ids;
    }

    /** @return array<string, mixed> */
    private function serialize(object $location): array
    {
        return [
            'id' => $location->id,
            'parent_id' => $location->parent_id,
            'url' => $location->url,
            'page_id' => $location->page_id,
            'block_id' => $location->block_id,
            'cursor_offset' => $location->cursor_offset === null ? null : (int) $location->cursor_offset,
            'selection_type' => $location->selection_type ?? null,
            'scroll_top' => (int) $location->scroll_top,
            'visited_at' => CarbonImmutable::parse($location->visited_at)->toIso8601String(),
            'last_visited_at' => CarbonImmutable::parse($location->last_visited_at)->toIso8601String(),
            'page_title' => $location->page_title ?? null,
            'node_text' => $location->node_text ?? null,
        ];
    }

    private function profileKey(): string
    {
        $accountUserId = $this->cloudAccount->account()['user']['id'] ?? null;

        if (is_string($accountUserId) && $accountUserId !== '') {
            return 'cloud:'.$accountUserId;
        }

        $cloudUserId = SyncState::current()?->cloud_user_id;

        return is_string($cloudUserId) && $cloudUserId !== ''
            ? 'cloud:'.$cloudUserId
            : 'local';
    }
}
