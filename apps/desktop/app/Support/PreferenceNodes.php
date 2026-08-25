<?php

namespace App\Support;

use App\Import\Roam\RoamPosition;
use App\Models\Node;
use App\Models\SyncState;
use App\Sync\CloudSyncService;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Ramsey\Uuid\Uuid;

/**
 * Preferences live in the normal synced node graph:
 *
 *   hidden workspace root -> hidden account root -> preference entries
 *
 * Entry IDs are UUIDv5-derived from their preference key. Their content is
 * the value, so future preferences can be added without changing the schema.
 */
final class PreferenceNodes
{
    public const ROOT_ID = SystemNodes::PREFERENCES_ROOT_ID;

    public const THEME_KEY = 'theme';

    public const DEFAULT_THEME = 'light';

    public const THEMES = [
        'dark',
        'light',
        'blush',
        'catppuccin-mocha',
        'catppuccin-latte',
        'gruvbox-dark',
        'gruvbox-light',
        'tokyo-night',
        'cyberpunk',
        'nord',
        'solarized-dark',
        'solarized-light',
        'cobalt2',
        'monokai',
        'oxblood',
    ];

    public const DARK_THEMES = [
        'dark',
        'catppuccin-mocha',
        'gruvbox-dark',
        'tokyo-night',
        'cyberpunk',
        'nord',
        'solarized-dark',
        'cobalt2',
        'monokai',
        'oxblood',
    ];

    public function __construct(
        private SyncService $sync,
        private CloudSyncService $cloud,
    ) {}

    /** @return array{root_id: string, theme: ?string} */
    public function listing(): array
    {
        $rootId = $this->activeRootId();
        $theme = Node::query()->find($this->entryId($rootId, self::THEME_KEY))?->content;

        return [
            'root_id' => $rootId,
            'theme' => in_array($theme, self::THEMES, true) ? $theme : null,
        ];
    }

    public function setTheme(string $theme): void
    {
        $this->set(self::THEME_KEY, $theme, 0);
    }

    private function set(string $key, string $value, int $position): void
    {
        DB::transaction(function () use ($key, $value, $position): void {
            $rootId = $this->activeRootId();
            $clock = $this->clock();
            $ops = $this->containerOps($rootId, $clock);
            $ops[] = $this->setOp(
                $this->entryId($rootId, $key),
                $rootId,
                $clock->now(),
                [
                    'parent_id' => $rootId,
                    'position' => RoamPosition::at($position),
                    'content' => $value,
                    'tiptap_content' => null,
                    'is_checked' => null,
                ],
            );

            $this->sync->push($ops);
        });
    }

    public function activeRootId(): string
    {
        $state = SyncState::current();

        if ($state === null) {
            $state = SyncState::create([
                'client_id' => (string) Str::uuid7(),
                'last_server_seq' => 0,
            ]);
        }

        if ($state->cloud_url && $state->cloud_workspace_id && ! $state->cloud_user_id) {
            try {
                $this->cloud->refreshCloudUserId();
                $state->refresh();
            } catch (\Throwable) {
                // Preferences remain fully local while the cloud is offline.
            }
        }

        $localRootId = $this->userRootId('local:'.$state->client_id);

        if (! is_string($state->cloud_user_id) || $state->cloud_user_id === '') {
            return $localRootId;
        }

        $cloudRootId = $this->userRootId('cloud:'.$state->cloud_user_id);
        $this->adoptAccountRoot($localRootId, $cloudRootId);

        return $cloudRootId;
    }

    private function adoptAccountRoot(string $localRootId, string $cloudRootId): void
    {
        if ($localRootId === $cloudRootId) {
            return;
        }

        $localRoot = Node::query()->find($localRootId);

        if ($localRoot === null) {
            return;
        }

        $clock = $this->clock();
        $hlc = $clock->now();
        $ops = $this->containerOps($cloudRootId, $clock);

        foreach ([self::THEME_KEY] as $position => $key) {
            $localEntry = Node::query()->find($this->entryId($localRootId, $key));
            $cloudEntry = Node::query()->find($this->entryId($cloudRootId, $key));

            if ($localEntry !== null && $cloudEntry === null) {
                $ops[] = $this->setOp(
                    $this->entryId($cloudRootId, $key),
                    $cloudRootId,
                    $hlc,
                    [
                        'parent_id' => $cloudRootId,
                        'position' => RoamPosition::at($position),
                        'content' => $localEntry->content,
                        'tiptap_content' => null,
                        'is_checked' => null,
                    ],
                );
            }

            if ($localEntry !== null) {
                $ops[] = $this->deleteOp($localEntry->id, $localRootId, $hlc);
            }
        }

        $ops[] = $this->deleteOp($localRootId, self::ROOT_ID, $hlc);
        $this->sync->push($ops);
    }

    /** @return list<array<string, mixed>> */
    private function containerOps(string $userRootId, HlcGenerator $clock): array
    {
        return [
            $this->setOp(self::ROOT_ID, self::ROOT_ID, $clock->now(), [
                'parent_id' => null,
                'position' => 'a0',
                'content' => '',
                'tiptap_content' => null,
                'is_checked' => null,
            ]),
            $this->setOp($userRootId, self::ROOT_ID, $clock->now(), [
                'parent_id' => self::ROOT_ID,
                'position' => 'a0',
                'content' => '',
                'tiptap_content' => null,
                'is_checked' => null,
            ]),
        ];
    }

    /** @param array<string, mixed> $fields */
    private function setOp(string $id, string $pageId, string $hlc, array $fields): array
    {
        return [
            'op_id' => (string) Str::uuid7(),
            'client_id' => $this->opClientId($hlc),
            'hlc' => $hlc,
            'type' => 'node.set',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $pageId,
                'fields' => $fields,
            ],
        ];
    }

    private function deleteOp(string $id, string $pageId, string $hlc): array
    {
        return [
            'op_id' => (string) Str::uuid7(),
            'client_id' => $this->opClientId($hlc),
            'hlc' => $hlc,
            'type' => 'node.delete',
            'payload' => [
                'v' => 1,
                'id' => $id,
                'page_id' => $pageId,
            ],
        ];
    }

    private function clock(): HlcGenerator
    {
        return new HlcGenerator('preferences-'.Str::uuid7());
    }

    private function opClientId(string $hlc): string
    {
        return substr($hlc, 21);
    }

    private function userRootId(string $identity): string
    {
        return Uuid::uuid5(self::ROOT_ID, $identity)->toString();
    }

    private function entryId(string $rootId, string $key): string
    {
        return Uuid::uuid5($rootId, $key)->toString();
    }
}
