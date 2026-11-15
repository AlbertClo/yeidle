import { HttpError, invalid, json } from '../../http/http';
import type { AppRequest } from '../../http/http';
import type { Router } from '../../http/router';
import { cloudFor } from '../cloud';
import type { AppContext } from '../context';
import { KeyBindingError, UserKeyBindings } from '../services/keyBindings';
import type { KeyboardPlatform } from '../services/keyBindings';

export function registerKeyBindingRoutes(
    router: Router,
    ctx: AppContext,
    keyBindings = new UserKeyBindings(ctx),
): void {
    router.get('/api/key-bindings', ({ request }) =>
        json(keyBindings.listing(platform(request))),
    );

    router.put('/api/key-bindings', ({ request, input }) => {
        const bindings = validateBindings(input.raw('bindings'));

        try {
            const listing = keyBindings.replace(bindings, platform(request));

            // In the background: saving a shortcut never waits on the cloud,
            // and an offline save is uploaded by the next account refresh
            void cloudFor(ctx)
                .account.saveKeyBindings(keyBindings.overrides())
                .catch(() => undefined);

            return json(listing);
        } catch (error) {
            if (error instanceof KeyBindingError) {
                invalid('bindings', error.message);
            }

            throw error;
        }
    });
}

/** `bindings` required array, `bindings.*` nullable string max 40. */
function validateBindings(value: unknown): Record<string, unknown> {
    const entries = Array.isArray(value)
        ? value.map((binding, i) => [String(i), binding] as const)
        : typeof value === 'object' && value !== null
          ? Object.entries(value)
          : null;

    if (entries === null) {
        invalid(
            'bindings',
            value === undefined || value === null || value === ''
                ? 'The bindings field is required.'
                : 'The bindings field must be an array.',
        );
    }

    if (entries.length === 0) {
        invalid('bindings', 'The bindings field is required.');
    }

    const errors: Record<string, string[]> = {};
    const bindings: Record<string, unknown> = {};

    for (const [command, raw] of entries) {
        // Laravel's ConvertEmptyStringsToNull turned '' into null
        const binding = raw === '' ? null : raw;

        if (binding !== null && typeof binding !== 'string') {
            errors[`bindings.${command}`] = [
                `The bindings.${command} field must be a string.`,
            ];
        } else if (typeof binding === 'string' && binding.length > 40) {
            errors[`bindings.${command}`] = [
                `The bindings.${command} field must not be greater than 40 characters.`,
            ];
        }

        bindings[command] = binding;
    }

    const first = Object.values(errors)[0];

    if (first) {
        throw new HttpError(422, first[0], errors);
    }

    return bindings;
}

function platform(request: AppRequest): KeyboardPlatform | null {
    const value = request.headers['x-yeidle-keyboard-platform'];

    return value === 'mac' || value === 'other' ? value : null;
}
