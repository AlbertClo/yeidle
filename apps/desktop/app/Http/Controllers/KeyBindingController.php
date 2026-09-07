<?php

namespace App\Http\Controllers;

use App\Accounts\CloudAccountService;
use App\Preferences\UserKeyBindings;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use InvalidArgumentException;

final class KeyBindingController extends Controller
{
    public function __construct(
        private readonly UserKeyBindings $keyBindings,
    ) {}

    public function show(Request $request): JsonResponse
    {
        return response()->json($this->keyBindings->listing($this->platform($request)));
    }

    public function update(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'bindings' => ['required', 'array'],
            'bindings.*' => ['nullable', 'string', 'max:40'],
        ]);

        try {
            $listing = $this->keyBindings->replace($validated['bindings'], $this->platform($request));

            try {
                app(CloudAccountService::class)
                    ->saveKeyBindings($this->keyBindings->overrides());
            } catch (\Throwable) {
                // Saving a local shortcut must keep working while cloud is unavailable.
            }

            return response()->json($listing);
        } catch (InvalidArgumentException $exception) {
            throw ValidationException::withMessages([
                'bindings' => $exception->getMessage(),
            ]);
        }
    }

    private function platform(Request $request): ?string
    {
        $platform = $request->header('X-Yeidle-Keyboard-Platform');

        return in_array($platform, ['mac', 'other'], true) ? $platform : null;
    }
}
