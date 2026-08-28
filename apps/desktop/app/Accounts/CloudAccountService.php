<?php

namespace App\Accounts;

use App\Models\SyncState;
use App\Preferences\UserKeyBindings;
use App\Sync\CloudSyncService;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Native\Desktop\Facades\Shell;
use RuntimeException;

final class CloudAccountService
{
    public function __construct(
        private readonly CloudAccountStore $store,
        private readonly WorkspaceIndex $workspaces,
        private readonly CloudSyncService $sync,
        private readonly UserKeyBindings $keyBindings,
    ) {}

    public function status(): array
    {
        $account = $this->store->account();
        $pending = $this->store->pending();

        return [
            'signed_in' => $account !== null,
            'user' => $account['user'] ?? null,
            'workspaces' => $account['workspaces'] ?? [],
            'preferences' => $account['preferences'] ?? ['key_bindings' => []],
            'authorization_pending' => $pending !== null,
            'authorization_id' => $pending['id'] ?? null,
            'authorization_expires_at' => $pending['expires_at'] ?? null,
            'verification_url' => $pending['verification_url'] ?? null,
            'authorization_realtime' => $pending['realtime'] ?? null,
        ];
    }

    public function begin(string $deviceName): array
    {
        $url = $this->cloudUrl();

        try {
            $response = Http::acceptJson()->connectTimeout(5)->timeout(15)
                ->post("{$url}/api/device-authorizations", [
                    'device_name' => trim($deviceName),
                ]);
        } catch (ConnectionException) {
            throw new RuntimeException('Could not reach Yeidle Cloud.');
        }

        if (! $response->created()) {
            throw new RuntimeException("Could not start sign in (HTTP {$response->status()}).");
        }

        $pending = [
            'id' => $response->json('id'),
            'secret' => $response->json('secret'),
            'verification_url' => $response->json('verification_url'),
            'expires_at' => $response->json('expires_at'),
            'cloud_url' => $url,
            'realtime' => $this->validateAuthorizationRealtime($response->json('realtime')),
        ];

        foreach (['id', 'secret', 'verification_url', 'expires_at'] as $key) {
            if (! is_string($pending[$key]) || $pending[$key] === '') {
                throw new RuntimeException('Yeidle Cloud returned an invalid sign-in request.');
            }
        }

        $this->store->savePending($pending);

        if (config('nativephp-internal.running')) {
            Shell::openExternal($pending['verification_url']);
        }

        return [
            'status' => 'pending',
            'authorization_id' => $pending['id'],
            'verification_url' => $pending['verification_url'],
            'expires_at' => $pending['expires_at'],
            'realtime' => $pending['realtime'],
        ];
    }

    public function completeAuthorization(): array
    {
        $pending = $this->store->pending();

        if ($pending === null) {
            throw new RuntimeException('No desktop sign-in request is pending.');
        }

        try {
            $response = Http::acceptJson()->connectTimeout(5)->timeout(15)
                ->post("{$pending['cloud_url']}/api/device-authorizations/{$pending['id']}/token", [
                    'secret' => $pending['secret'],
                ]);
        } catch (ConnectionException) {
            throw new RuntimeException('Could not reach Yeidle Cloud.');
        }

        if ($response->status() === 202) {
            return ['status' => 'pending'];
        }

        if ($response->status() === 410) {
            $this->store->clear();

            return ['status' => 'expired'];
        }

        if (! $response->successful()) {
            throw new RuntimeException("Could not finish sign in (HTTP {$response->status()}).");
        }

        $token = $response->json('token');
        $user = $response->json('user');
        $workspaces = $response->json('workspaces');
        $preferences = $response->json('preferences');

        if (! is_string($token) || $token === ''
            || ! is_array($user) || ! is_string($user['id'] ?? null)
            || ! is_array($workspaces) || ! is_array($preferences)) {
            throw new RuntimeException('Yeidle Cloud returned an invalid account session.');
        }

        $account = [
            'cloud_url' => $pending['cloud_url'],
            'token' => $token,
            'user' => $user,
            'workspaces' => $workspaces,
            'preferences' => $preferences,
        ];
        $this->store->saveAccount($account);
        $this->keyBindings->importCloud($preferences['key_bindings'] ?? []);
        $this->workspaces->syncCloudCatalog($user['id'], $workspaces);

        return ['status' => 'approved', ...$this->status()];
    }

    public function authorizePendingRealtime(string $socketId, string $channelName): array
    {
        $pending = $this->store->pending();

        if ($pending === null) {
            throw new RuntimeException('No desktop sign-in request is pending.');
        }

        $expectedChannel = "private-device-authorizations.{$pending['id']}";

        if (! hash_equals($expectedChannel, $channelName)) {
            throw new RuntimeException('The device authorization channel is not allowed.');
        }

        try {
            $response = Http::acceptJson()->asForm()->connectTimeout(5)->timeout(15)
                ->post("{$pending['cloud_url']}/api/device-authorizations/{$pending['id']}/broadcasting-auth", [
                    'secret' => $pending['secret'],
                    'socket_id' => $socketId,
                    'channel_name' => $channelName,
                ]);
        } catch (ConnectionException) {
            throw new RuntimeException('Could not authorize realtime sign in.');
        }

        $authorization = $response->json();

        if (! $response->successful()
            || ! is_array($authorization)
            || ! is_string($authorization['auth'] ?? null)
            || $authorization['auth'] === '') {
            throw new RuntimeException('Realtime sign-in authorization failed.');
        }

        return $authorization;
    }

    public function cancelAuthorization(): void
    {
        $this->store->clearPending();
    }

    public function refresh(): array
    {
        $account = $this->requireAccount();
        try {
            $workspaceResponse = $this->request($account)
                ->get("{$account['cloud_url']}/api/workspaces");
            $preferenceResponse = ($account['preferences_dirty'] ?? false)
                ? $this->request($account)->put("{$account['cloud_url']}/api/user/preferences", [
                    'key_bindings' => $this->keyBindings->overrides(),
                ])
                : $this->request($account)->get("{$account['cloud_url']}/api/user/preferences");
        } catch (ConnectionException) {
            throw new RuntimeException('Could not refresh the Yeidle account.');
        }

        if (in_array($workspaceResponse->status(), [401, 403], true)
            || in_array($preferenceResponse->status(), [401, 403], true)) {
            $this->clearLocalAccount();

            throw new RuntimeException('Your Yeidle sign-in expired. Sign in again.');
        }

        if (! $workspaceResponse->successful() || ! is_array($workspaceResponse->json('workspaces'))) {
            throw new RuntimeException('Could not refresh cloud workspaces.');
        }

        $workspaces = $workspaceResponse->json('workspaces');
        $this->store->updateWorkspaces($workspaces);
        $this->workspaces->syncCloudCatalog($account['user']['id'], $workspaces);

        if (! $preferenceResponse->successful()) {
            throw new RuntimeException('Could not refresh account preferences.');
        }

        $preferences = [
            'key_bindings' => $preferenceResponse->json('key_bindings', []),
        ];
        $this->store->updatePreferences($preferences);
        $this->keyBindings->importCloud($preferences['key_bindings']);

        return $this->status();
    }

    public function syncActiveWorkspace(): array
    {
        $account = $this->requireAccount();
        $workspace = $this->workspaces->active();

        if ($workspace['cloud_status'] === 'local') {
            return ['synced' => false, 'reason' => 'local'];
        }

        if (! collect($account['workspaces'])->contains('id', $workspace['id'])) {
            $this->workspaces->syncCloudCatalog(
                $account['user']['id'],
                $account['workspaces'],
            );

            return ['synced' => false, 'reason' => 'unavailable'];
        }

        $this->workspaces->markCloudStatus($workspace['id'], 'syncing');

        try {
            $result = $this->sync->connect(
                $account['cloud_url'],
                $account['token'],
                $workspace['id'],
            );
            $this->workspaces->markCloudStatus($workspace['id'], 'ready');

            return ['synced' => true, 'result' => $result];
        } catch (\Throwable $exception) {
            $this->workspaces->markCloudStatus($workspace['id'], 'error', $exception->getMessage());

            throw new RuntimeException($exception->getMessage(), previous: $exception);
        }
    }

    public function enableWorkspaceSync(string $workspaceId): array
    {
        $account = $this->requireAccount();
        $localWorkspace = $this->workspaces->find($workspaceId);

        if ($localWorkspace['cloud_status'] !== 'local') {
            throw new RuntimeException('This workspace is already connected to Yeidle Cloud.');
        }

        try {
            $response = $this->request($account)
                ->post("{$account['cloud_url']}/api/workspaces", [
                    'id' => $workspaceId,
                    'name' => $localWorkspace['name'],
                ]);
        } catch (ConnectionException) {
            throw new RuntimeException('Could not create the cloud workspace.');
        }

        $workspace = $response->json('workspace');

        if (! $response->created()
            || ! is_array($workspace)
            || ! is_string($workspace['id'] ?? null)
            || ! is_string($workspace['name'] ?? null)) {
            throw new RuntimeException(
                $response->json('message', "Could not create the cloud workspace (HTTP {$response->status()})."),
            );
        }

        $workspaces = collect($account['workspaces'] ?? [])
            ->reject(fn (array $existing): bool => ($existing['id'] ?? null) === $workspace['id'])
            ->push($workspace)
            ->values()
            ->all();
        $this->store->updateWorkspaces($workspaces);
        $this->workspaces->syncCloudCatalog($account['user']['id'], $workspaces);

        return $this->workspaces->find($workspaceId);
    }

    public function renameWorkspace(string $workspaceId, string $name): array
    {
        $account = $this->requireAccount();
        $localWorkspace = $this->workspaces->find($workspaceId);

        if ($localWorkspace['cloud_owned'] !== true) {
            throw new RuntimeException('Only the workspace owner can rename it.');
        }

        try {
            $response = $this->request($account)
                ->patch("{$account['cloud_url']}/api/workspaces/{$workspaceId}", [
                    'name' => trim($name),
                ]);
        } catch (ConnectionException) {
            throw new RuntimeException('Could not rename the cloud workspace.');
        }

        $workspace = $response->json('workspace');

        if (! $response->successful()
            || ! is_array($workspace)
            || ! is_string($workspace['id'] ?? null)
            || ! is_string($workspace['name'] ?? null)) {
            throw new RuntimeException(
                $response->json('message', "Could not rename the cloud workspace (HTTP {$response->status()})."),
            );
        }

        $workspaces = collect($account['workspaces'] ?? [])
            ->reject(fn (array $existing): bool => ($existing['id'] ?? null) === $workspace['id'])
            ->push($workspace)
            ->values()
            ->all();
        $this->store->updateWorkspaces($workspaces);
        $this->workspaces->syncCloudCatalog($account['user']['id'], $workspaces);

        return $this->workspaces->find($workspaceId);
    }

    public function deleteWorkspace(string $workspaceId): array
    {
        $localWorkspace = $this->workspaces->find($workspaceId);

        if ($localWorkspace['cloud_owned'] !== true) {
            throw new RuntimeException('Only the workspace owner can delete it.');
        }

        $account = $this->requireAccount();

        try {
            $response = $this->request($account)
                ->delete("{$account['cloud_url']}/api/workspaces/{$workspaceId}");
        } catch (ConnectionException) {
            throw new RuntimeException('Could not delete the cloud workspace.');
        }

        if (! $response->successful()) {
            throw new RuntimeException(
                $response->json('message', "Could not delete the cloud workspace (HTTP {$response->status()})."),
            );
        }

        $workspaces = collect($account['workspaces'] ?? [])
            ->reject(fn (array $workspace): bool => ($workspace['id'] ?? null) === $workspaceId)
            ->values()
            ->all();
        $this->store->updateWorkspaces($workspaces);

        return $this->workspaces->delete($workspaceId);
    }

    public function logout(): void
    {
        $account = $this->store->account();

        if ($account !== null) {
            try {
                Http::withToken($account['token'])->acceptJson()->connectTimeout(5)->timeout(10)
                    ->delete("{$account['cloud_url']}/api/device");
            } catch (\Throwable) {
                // Local logout must succeed even while offline.
            }
        }

        $this->clearLocalAccount();
    }

    private function clearLocalAccount(): void
    {
        $this->store->clear();
        SyncState::current()?->update([
            'cloud_url' => null,
            'cloud_token' => null,
            'workspace_id' => null,
            'cloud_seed_pending' => false,
            'last_sync_error' => null,
        ]);
    }

    /** @param array<string, ?string> $keyBindings */
    public function saveKeyBindings(array $keyBindings): void
    {
        $account = $this->store->account();

        if ($account === null) {
            return;
        }

        $preferences = ['key_bindings' => $keyBindings];
        $this->store->saveLocalPreferences($preferences);

        try {
            $response = $this->request($account)
                ->put("{$account['cloud_url']}/api/user/preferences", $preferences);

            if ($response->successful()) {
                $this->store->updatePreferences([
                    'key_bindings' => $response->json('key_bindings', []),
                ]);
            }
        } catch (\Throwable) {
            // The dirty local copy is uploaded on the next account refresh.
        }
    }

    public function account(): ?array
    {
        return $this->store->account();
    }

    private function requireAccount(): array
    {
        return $this->store->account()
            ?? throw new RuntimeException('Sign in to Yeidle Cloud first.');
    }

    private function cloudUrl(): string
    {
        $url = rtrim((string) config('services.yeidle.url'), '/');

        if (! filter_var($url, FILTER_VALIDATE_URL)) {
            throw new RuntimeException('Yeidle Cloud is not configured.');
        }

        return $url;
    }

    private function request(array $account): PendingRequest
    {
        return Http::withToken($account['token'])
            ->acceptJson()
            ->connectTimeout(5)
            ->timeout(15);
    }

    private function validateAuthorizationRealtime(mixed $realtime): array
    {
        if (! is_array($realtime)
            || ($realtime['enabled'] ?? false) !== true
            || ! is_string($realtime['app_key'] ?? null)
            || $realtime['app_key'] === ''
            || ! is_string($realtime['host'] ?? null)
            || $realtime['host'] === ''
            || ! is_int($realtime['port'] ?? null)
            || $realtime['port'] < 1
            || $realtime['port'] > 65535
            || ! in_array($realtime['scheme'] ?? null, ['http', 'https'], true)) {
            throw new RuntimeException('Yeidle Cloud realtime sign in is unavailable.');
        }

        return [
            'enabled' => true,
            'app_key' => $realtime['app_key'],
            'host' => $realtime['host'],
            'port' => $realtime['port'],
            'scheme' => $realtime['scheme'],
        ];
    }
}
