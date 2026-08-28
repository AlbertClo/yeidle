<?php

namespace App\Http\Controllers;

use App\Accounts\CloudAccountService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use RuntimeException;

class CloudAccountController extends Controller
{
    public function __construct(private readonly CloudAccountService $account) {}

    public function show(): JsonResponse
    {
        return response()->json($this->account->status());
    }

    public function connect(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'device_name' => ['nullable', 'string', 'max:100'],
        ]);

        try {
            return response()->json($this->account->begin(
                $validated['device_name'] ?? 'Yeidle on '.php_uname('n'),
            ), 201);
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function completeAuthorization(): JsonResponse
    {
        try {
            return response()->json($this->account->completeAuthorization());
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function authorizeRealtime(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'socket_id' => ['required', 'string', 'regex:/^\d+\.\d+$/'],
            'channel_name' => ['required', 'string'],
        ]);

        try {
            return response()->json($this->account->authorizePendingRealtime(
                $validated['socket_id'],
                $validated['channel_name'],
            ));
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 403);
        }
    }

    public function cancelAuthorization(): JsonResponse
    {
        $this->account->cancelAuthorization();

        return response()->json(['cancelled' => true]);
    }

    public function refresh(): JsonResponse
    {
        try {
            return response()->json($this->account->refresh());
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function syncActiveWorkspace(): JsonResponse
    {
        try {
            return response()->json($this->account->syncActiveWorkspace());
        } catch (RuntimeException $exception) {
            return response()->json(['message' => $exception->getMessage()], 422);
        }
    }

    public function destroy(): JsonResponse
    {
        $this->account->logout();

        return response()->json(['signed_out' => true]);
    }
}
