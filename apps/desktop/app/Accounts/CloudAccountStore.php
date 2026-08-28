<?php

namespace App\Accounts;

use JsonException;
use RuntimeException;

final class CloudAccountStore
{
    private const VERSION = 1;

    public function __construct(private readonly string $path) {}

    public function account(): ?array
    {
        return $this->read()['account'];
    }

    public function pending(): ?array
    {
        return $this->read()['pending'];
    }

    public function saveAccount(array $account): void
    {
        $state = $this->read();
        $state['account'] = $account;
        $state['pending'] = null;
        $this->write($state);
    }

    public function savePending(array $pending): void
    {
        $state = $this->read();
        $state['pending'] = $pending;
        $this->write($state);
    }

    public function clearPending(): void
    {
        $state = $this->read();
        $state['pending'] = null;
        $this->write($state);
    }

    public function updateWorkspaces(array $workspaces): void
    {
        $state = $this->read();

        if (! is_array($state['account'])) {
            throw new RuntimeException('No cloud account is signed in.');
        }

        $state['account']['workspaces'] = $workspaces;
        $this->write($state);
    }

    public function updatePreferences(array $preferences): void
    {
        $state = $this->read();

        if (! is_array($state['account'])) {
            throw new RuntimeException('No cloud account is signed in.');
        }

        $state['account']['preferences'] = $preferences;
        $state['account']['preferences_dirty'] = false;
        $this->write($state);
    }

    public function saveLocalPreferences(array $preferences): void
    {
        $state = $this->read();

        if (! is_array($state['account'])) {
            return;
        }

        $state['account']['preferences'] = $preferences;
        $state['account']['preferences_dirty'] = true;
        $this->write($state);
    }

    public function clear(): void
    {
        $this->write($this->initialState());
    }

    /** @return array{version: int, account: ?array, pending: ?array} */
    private function read(): array
    {
        if (! is_file($this->path)) {
            return $this->initialState();
        }

        try {
            $state = json_decode((string) file_get_contents($this->path), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new RuntimeException('The cloud account file is not valid JSON.', previous: $exception);
        }

        if (! is_array($state)
            || ($state['version'] ?? null) !== self::VERSION
            || (! is_array($state['account'] ?? null) && ($state['account'] ?? null) !== null)
            || (! is_array($state['pending'] ?? null) && ($state['pending'] ?? null) !== null)) {
            throw new RuntimeException('The cloud account file is invalid.');
        }

        return $state;
    }

    /** @return array{version: int, account: null, pending: null} */
    private function initialState(): array
    {
        return ['version' => self::VERSION, 'account' => null, 'pending' => null];
    }

    private function write(array $state): void
    {
        $directory = dirname($this->path);

        if (! is_dir($directory) && ! mkdir($directory, 0700, true) && ! is_dir($directory)) {
            throw new RuntimeException('The cloud account directory could not be created.');
        }

        try {
            $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR).PHP_EOL;
        } catch (JsonException $exception) {
            throw new RuntimeException('The cloud account could not be encoded.', previous: $exception);
        }

        $temporaryPath = $this->path.'.tmp-'.bin2hex(random_bytes(6));

        if (file_put_contents($temporaryPath, $json, LOCK_EX) === false
            || ! rename($temporaryPath, $this->path)) {
            @unlink($temporaryPath);

            throw new RuntimeException('The cloud account could not be saved.');
        }

        @chmod($this->path, 0600);
    }
}
