<?php

namespace App\Http\Controllers;

use App\Support\PreferenceNodes;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class PreferenceController extends Controller
{
    public function __construct(
        private PreferenceNodes $preferences,
    ) {}

    public function show(): JsonResponse
    {
        return response()->json($this->preferences->listing());
    }

    public function updateTheme(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'theme' => ['required', 'string', Rule::in(PreferenceNodes::THEMES)],
        ]);

        $this->preferences->setTheme($validated['theme']);

        return response()->json($this->preferences->listing());
    }

    public function updateTypography(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'font_family' => ['required', 'string', Rule::in(PreferenceNodes::FONT_FAMILIES)],
            'font_size' => [
                'required',
                'integer',
                'between:'.PreferenceNodes::MIN_FONT_SIZE.','.PreferenceNodes::MAX_FONT_SIZE,
            ],
        ]);

        $this->preferences->setTypography(
            $validated['font_family'],
            $validated['font_size'],
        );

        return response()->json($this->preferences->listing());
    }
}
