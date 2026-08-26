<?php

namespace App\Http\Controllers;

use App\Preferences\UserKeyBindings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

final class KeyBindingController extends Controller
{
    public function __construct(private readonly UserKeyBindings $keyBindings) {}

    public function show(): JsonResponse
    {
        return response()->json($this->keyBindings->listing());
    }

    public function update(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'bindings' => ['required', 'array'],
            'bindings.*' => ['nullable', 'string', 'max:40'],
        ]);

        try {
            return response()->json($this->keyBindings->replace($validated['bindings']));
        } catch (InvalidArgumentException $exception) {
            throw ValidationException::withMessages([
                'bindings' => $exception->getMessage(),
            ]);
        }
    }
}
