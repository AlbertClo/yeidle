<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\DeviceAuthorization;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Broadcast;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

class DeviceAuthorizationController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'device_name' => ['required', 'string', 'max:100'],
        ]);
        $secret = Str::random(64);
        $authorization = DeviceAuthorization::create([
            'device_name' => trim($validated['device_name']),
            'secret_hash' => hash('sha256', $secret),
            'expires_at' => now()->addMinutes(10),
        ]);

        return response()->json([
            'id' => $authorization->id,
            'secret' => $secret,
            'verification_url' => route('device-authorizations.show', $authorization),
            'expires_at' => $authorization->expires_at->toIso8601String(),
            'realtime' => $this->realtimeConfig(),
        ], 201);
    }

    public function authorizeRealtime(Request $request, DeviceAuthorization $deviceAuthorization): JsonResponse
    {
        $validated = $request->validate([
            'secret' => ['required', 'string', 'size:64'],
            'socket_id' => ['required', 'string', 'regex:/^\d+\.\d+$/'],
            'channel_name' => ['required', 'string'],
        ]);
        $expectedChannel = "private-device-authorizations.{$deviceAuthorization->id}";

        abort_unless(
            hash_equals($deviceAuthorization->secret_hash, hash('sha256', $validated['secret']))
            && ! $deviceAuthorization->expires_at->isPast()
            && hash_equals($expectedChannel, $validated['channel_name']),
            403,
        );

        return response()->json(
            Broadcast::connection()->validAuthenticationResponse($request, true),
        );
    }

    public function token(Request $request, DeviceAuthorization $deviceAuthorization): JsonResponse
    {
        $validated = $request->validate([
            'secret' => ['required', 'string', 'size:64'],
        ]);

        if (! hash_equals($deviceAuthorization->secret_hash, hash('sha256', $validated['secret']))) {
            abort(404);
        }

        if ($deviceAuthorization->expires_at->isPast()) {
            return response()->json(['status' => 'expired'], 410);
        }

        if ($deviceAuthorization->approved_at === null || $deviceAuthorization->user_id === null) {
            return response()->json(['status' => 'pending'], 202);
        }

        $authorization = DB::transaction(function () use ($deviceAuthorization): DeviceAuthorization {
            $authorization = DeviceAuthorization::query()
                ->lockForUpdate()
                ->findOrFail($deviceAuthorization->id);

            if ($authorization->issued_token === null) {
                $authorization->issued_token = $authorization->user
                    ->createToken($authorization->device_name, ['desktop'])
                    ->plainTextToken;
                $authorization->consumed_at = now();
                $authorization->save();
            }

            return $authorization;
        });
        $user = $authorization->user;
        $workspaces = $user->workspaces()
            ->orderBy('workspaces.created_at')
            ->get(['workspaces.id', 'workspaces.user_id', 'workspaces.name'])
            ->map(fn ($workspace) => [
                'id' => $workspace->id,
                'name' => $workspace->name,
                'role' => $workspace->pivot->role,
                'owned' => $workspace->user_id === $user->id,
            ])
            ->values();
        $preferences = is_array($user->preferences) ? $user->preferences : [];

        return response()->json([
            'status' => 'approved',
            'token' => $authorization->issued_token,
            'user' => [
                'id' => (string) $user->id,
                'name' => $user->name,
                'email' => $user->email,
            ],
            'workspaces' => $workspaces,
            'preferences' => [
                'key_bindings' => is_array($preferences['key_bindings'] ?? null)
                    ? $preferences['key_bindings']
                    : [],
            ],
        ]);
    }

    public function destroy(Request $request): JsonResponse
    {
        $token = $request->user()->currentAccessToken();

        if ($token !== null && method_exists($token, 'delete')) {
            $token->delete();
        }

        return response()->json(['revoked' => true]);
    }

    private function realtimeConfig(): array
    {
        $config = config('reverb.public');
        $enabled = config('broadcasting.default') === 'reverb'
            && is_array($config)
            && is_string($config['app_key'] ?? null)
            && ($config['app_key'] ?? '') !== '';

        return [
            'enabled' => $enabled,
            'app_key' => $enabled ? $config['app_key'] : null,
            'host' => $enabled ? $config['host'] : null,
            'port' => $enabled ? $config['port'] : null,
            'scheme' => $enabled ? $config['scheme'] : null,
        ];
    }
}
