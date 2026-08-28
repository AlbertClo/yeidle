<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class AccountPreferenceController extends Controller
{
    public function show(Request $request): JsonResponse
    {
        return response()->json($this->response($request));
    }

    public function update(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'key_bindings' => ['required', 'array', 'max:50'],
            'key_bindings.*' => ['nullable', 'string', 'max:64'],
        ]);

        foreach (array_keys($validated['key_bindings']) as $command) {
            if (! is_string($command) || preg_match('/^[a-z0-9-]+$/D', $command) !== 1) {
                throw ValidationException::withMessages([
                    'key_bindings' => 'The keyboard preference contains an invalid command.',
                ]);
            }
        }

        $user = $request->user();
        $preferences = is_array($user->preferences) ? $user->preferences : [];
        $preferences['key_bindings'] = $validated['key_bindings'];
        $user->preferences = $preferences;
        $user->save();

        return response()->json($this->response($request));
    }

    /** @return array{key_bindings: array<string, string|null>, updated_at: ?string} */
    private function response(Request $request): array
    {
        $user = $request->user();
        $preferences = is_array($user->preferences) ? $user->preferences : [];
        $bindings = is_array($preferences['key_bindings'] ?? null)
            ? $preferences['key_bindings']
            : [];

        return [
            'key_bindings' => $bindings,
            'updated_at' => $user->updated_at?->toIso8601String(),
        ];
    }
}
