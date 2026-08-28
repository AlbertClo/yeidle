<?php

namespace App\Preferences;

use App\Accounts\CloudAccountStore;
use App\Models\SyncState;
use InvalidArgumentException;
use JsonException;
use RuntimeException;

final class UserKeyBindings
{
    private const VERSION = 1;

    public const DEFAULTS = [
        'command-palette' => 'Mod+P',
        'all-pages' => 'Alt+A',
        'toggle-left-sidebar' => 'Mod+Backslash',
        'find-page' => 'Mod+U',
        'toggle-pin' => 'Alt+P',
        'pinned-item-1' => 'Alt+1',
        'pinned-item-2' => 'Alt+2',
        'pinned-item-3' => 'Alt+3',
        'pinned-item-4' => 'Alt+4',
        'pinned-item-5' => 'Alt+5',
        'pinned-item-6' => 'Alt+6',
        'pinned-item-7' => 'Alt+7',
        'pinned-item-8' => 'Alt+8',
        'pinned-item-9' => 'Alt+9',
        'pinned-item-10' => 'Alt+0',
        'toggle-checkbox' => 'Mod+Enter',
        'reload' => 'Mod+R',
        'back' => 'Mod+ArrowLeft',
        'forward' => 'Mod+ArrowRight',
    ];

    private const MODIFIERS = ['Mod', 'Alt', 'Shift'];

    private const KEYS = [
        'Enter',
        'Tab',
        'Space',
        'Backspace',
        'Delete',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Plus',
        'Minus',
        'Equal',
        'Comma',
        'Period',
        'Slash',
        'Backslash',
        'Semicolon',
        'Quote',
        'BracketLeft',
        'BracketRight',
        'Backquote',
    ];

    public function __construct(
        private readonly string $path,
        private readonly ?CloudAccountStore $cloudAccount = null,
    ) {}

    /** @return array{bindings: array<string, ?string>, defaults: array<string, string>} */
    public function listing(): array
    {
        $state = $this->read();
        $profile = $this->profile($state);

        return [
            'bindings' => array_replace(self::DEFAULTS, $profile['key_bindings'] ?? []),
            'defaults' => self::DEFAULTS,
        ];
    }

    /**
     * @param  array<string, mixed>  $bindings
     * @return array{bindings: array<string, ?string>, defaults: array<string, string>}
     */
    public function replace(array $bindings): array
    {
        $state = $this->read();
        $profileKey = $this->profileKey();
        $current = array_replace(
            self::DEFAULTS,
            $this->profile($state)['key_bindings'] ?? [],
        );

        foreach ($bindings as $command => $binding) {
            if (! array_key_exists($command, self::DEFAULTS)) {
                throw new InvalidArgumentException("Unknown shortcut command [{$command}].");
            }

            if ($binding !== null && ! is_string($binding)) {
                throw new InvalidArgumentException('Shortcut bindings must be strings or null.');
            }

            $current[$command] = $binding === null
                ? null
                : $this->normalize($binding);
        }

        $assigned = array_values(array_filter($current, is_string(...)));

        if (count($assigned) !== count(array_unique($assigned))) {
            throw new InvalidArgumentException('Each shortcut must use a unique key combination.');
        }

        $overrides = [];

        foreach ($current as $command => $binding) {
            if ($binding !== self::DEFAULTS[$command]) {
                $overrides[$command] = $binding;
            }
        }

        $state['profiles'][$profileKey] = ['key_bindings' => $overrides];
        $this->write($state);

        return [
            'bindings' => $current,
            'defaults' => self::DEFAULTS,
        ];
    }

    /** @return array<string, ?string> */
    public function overrides(): array
    {
        $state = $this->read();

        return $this->profile($state)['key_bindings'] ?? [];
    }

    /** @param array<string, mixed> $bindings */
    public function importCloud(array $bindings): array
    {
        $state = $this->read();
        $profileKey = $this->profileKey();
        $normalized = [];

        foreach ($bindings as $command => $binding) {
            if (! is_string($command)
                || ! array_key_exists($command, self::DEFAULTS)
                || ($binding !== null && ! is_string($binding))) {
                continue;
            }

            $normalized[$command] = $binding === null
                ? null
                : $this->normalize($binding);
        }

        $state['profiles'][$profileKey] = ['key_bindings' => $normalized];
        $this->write($state);

        return $this->listing();
    }

    /** @param array{version: int, profiles: array<string, array{key_bindings?: array<string, ?string>}>} $state */
    private function profile(array &$state): array
    {
        $profileKey = $this->profileKey();

        if ($profileKey !== 'local'
            && ! array_key_exists($profileKey, $state['profiles'])
            && array_key_exists('local', $state['profiles'])) {
            $state['profiles'][$profileKey] = $state['profiles']['local'];
            $this->write($state);
        }

        return $state['profiles'][$profileKey] ?? [];
    }

    private function profileKey(): string
    {
        $accountUserId = $this->cloudAccount?->account()['user']['id'] ?? null;

        if (is_string($accountUserId) && $accountUserId !== '') {
            return 'cloud:'.$accountUserId;
        }

        $cloudUserId = SyncState::current()?->cloud_user_id;

        return is_string($cloudUserId) && $cloudUserId !== ''
            ? 'cloud:'.$cloudUserId
            : 'local';
    }

    private function normalize(string $binding): string
    {
        $parts = explode('+', trim($binding));
        $key = array_pop($parts);

        if ($key === null || $key === '') {
            throw new InvalidArgumentException('The shortcut key combination is invalid.');
        }

        if (strlen($key) === 1 && ctype_alnum($key)) {
            $key = strtoupper($key);
        }

        $functionKey = preg_match('/^F(?:[1-9]|1[0-2])$/', $key) === 1;

        if (! $functionKey && ! in_array($key, self::KEYS, true) && ! preg_match('/^[A-Z0-9]$/', $key)) {
            throw new InvalidArgumentException("Shortcut key [{$key}] is not supported.");
        }

        if ($parts === [] && ! $functionKey) {
            throw new InvalidArgumentException('Shortcuts must include a modifier key.');
        }

        if (count($parts) !== count(array_unique($parts))) {
            throw new InvalidArgumentException('A shortcut cannot repeat modifier keys.');
        }

        foreach ($parts as $modifier) {
            if (! in_array($modifier, self::MODIFIERS, true)) {
                throw new InvalidArgumentException("Shortcut modifier [{$modifier}] is not supported.");
            }
        }

        $ordered = array_values(array_filter(
            self::MODIFIERS,
            fn (string $modifier): bool => in_array($modifier, $parts, true),
        ));

        return implode('+', [...$ordered, $key]);
    }

    /** @return array{version: int, profiles: array<string, array{key_bindings?: array<string, ?string>}>} */
    private function read(): array
    {
        if (! is_file($this->path)) {
            return $this->initialState();
        }

        try {
            $state = json_decode((string) file_get_contents($this->path), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new RuntimeException('The local user preferences are not valid JSON.', previous: $exception);
        }

        if (! is_array($state)
            || ($state['version'] ?? null) !== self::VERSION
            || ! is_array($state['profiles'] ?? null)) {
            throw new RuntimeException('The local user preferences are invalid.');
        }

        foreach ($state['profiles'] as $profileKey => $profile) {
            if (! is_string($profileKey)
                || ! is_array($profile)
                || ! is_array($profile['key_bindings'] ?? null)) {
                throw new RuntimeException('The local user preferences contain an invalid profile.');
            }

            foreach ($profile['key_bindings'] as $command => $binding) {
                if (! is_string($command)
                    || ! array_key_exists($command, self::DEFAULTS)
                    || ($binding !== null && ! is_string($binding))) {
                    throw new RuntimeException('The local user preferences contain an invalid shortcut.');
                }
            }
        }

        /** @var array{version: int, profiles: array<string, array{key_bindings?: array<string, ?string>}>} $state */
        return $state;
    }

    /** @return array{version: int, profiles: array<string, array{key_bindings?: array<string, ?string>}>} */
    private function initialState(): array
    {
        return ['version' => self::VERSION, 'profiles' => []];
    }

    /** @param array{version: int, profiles: array<string, array{key_bindings?: array<string, ?string>}>} $state */
    private function write(array $state): void
    {
        $directory = dirname($this->path);

        if (! is_dir($directory) && ! mkdir($directory, 0700, true) && ! is_dir($directory)) {
            throw new RuntimeException('The user preferences directory could not be created.');
        }

        try {
            $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).PHP_EOL;
        } catch (JsonException $exception) {
            throw new RuntimeException('The local user preferences could not be encoded.', previous: $exception);
        }

        $temporaryPath = $this->path.'.tmp-'.bin2hex(random_bytes(6));

        if (file_put_contents($temporaryPath, $json, LOCK_EX) === false
            || ! rename($temporaryPath, $this->path)) {
            @unlink($temporaryPath);

            throw new RuntimeException('The local user preferences could not be saved.');
        }

        @chmod($this->path, 0600);
    }
}
