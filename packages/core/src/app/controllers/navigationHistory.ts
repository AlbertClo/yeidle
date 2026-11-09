import { abort, empty, invalid, json } from '../../http/http';
import type { Input } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid } from '../../support/ids';
import { parseTimestamp } from '../../support/time';
import type { AppContext } from '../context';
import { NavigationHistoryStore } from '../services/navigationHistory';
import type { NavigationLocationInput } from '../services/navigationHistory';

export function registerNavigationHistoryRoutes(
    router: Router,
    ctx: AppContext,
    history = new NavigationHistoryStore(ctx),
): void {
    router.get('/api/navigation-history', () => json(history.get()));

    router.delete('/api/navigation-history', () => {
        history.clear();

        return empty(204);
    });

    router.put('/api/navigation-history/current', ({ input }) => {
        const id = requiredUuid(input, 'id');
        history.setCurrent(id);

        return json({ current_id: id });
    });

    router.put(
        '/api/navigation-history/locations/{locationId}',
        ({ params, input }) => {
            const location = validateLocation(input);
            const makeCurrent = input.has('make_current')
                ? input.boolean('make_current')
                : false;

            if (!isUuid(params.locationId)) {
                abort(404);
            }

            location.url = canonicalUrl(location.url);

            if (urlPath(location.url) === '/navigation-history') {
                return empty(204);
            }

            return json(history.save(params.locationId, location, makeCurrent));
        },
    );
}

/** Props for the NavigationHistory/Index Inertia page; the page loads its data from the API. */
export function navigationHistoryPageProps(
    _ctx: AppContext,
): Record<string, unknown> {
    return {};
}

function validateLocation(input: Input): NavigationLocationInput {
    const url = input.string('url', { max: 2048 });

    if (!url.startsWith('/')) {
        invalid(
            'url',
            'The url field must start with one of the following: /.',
        );
    }

    const selectionType = input.optionalString('selection_type');

    if (
        selectionType !== null &&
        selectionType !== 'text' &&
        selectionType !== 'node'
    ) {
        invalid('selection_type', 'The selected selection_type is invalid.');
    }

    if (
        !input.has('scroll_top') ||
        input.raw('scroll_top') === null ||
        input.raw('scroll_top') === ''
    ) {
        invalid('scroll_top', 'The scroll_top field is required.');
    }

    return {
        parent_id: optionalUuid(input, 'parent_id'),
        url,
        page_id: optionalUuid(input, 'page_id'),
        block_id: optionalUuid(input, 'block_id'),
        cursor_offset: input.optionalInteger('cursor_offset', { min: 0 }),
        selection_type: selectionType,
        scroll_top: input.integer('scroll_top', { min: 0 }),
        visited_at: requiredDate(input, 'visited_at'),
        last_visited_at: requiredDate(input, 'last_visited_at'),
    };
}

function optionalUuid(input: Input, key: string): string | null {
    const value = input.optionalString(key);

    if (value !== null && !isUuid(value)) {
        invalid(key, `The ${key} field must be a valid UUID.`);
    }

    return value;
}

function requiredUuid(input: Input, key: string): string {
    const value = input.string(key);

    if (!isUuid(value)) {
        invalid(key, `The ${key} field must be a valid UUID.`);
    }

    return value;
}

function requiredDate(input: Input, key: string): string {
    const value = input.string(key);

    if (parseTimestamp(value) === null) {
        invalid(key, `The ${key} field must be a valid date.`);
    }

    return value;
}

function splitUrl(url: string): { path: string; query: string } {
    const withoutFragment = url.split('#', 1)[0];
    const index = withoutFragment.indexOf('?');

    return index === -1
        ? { path: withoutFragment, query: '' }
        : {
              path: withoutFragment.slice(0, index),
              query: withoutFragment.slice(index + 1),
          };
}

function urlPath(url: string): string {
    return splitUrl(url).path;
}

/** Root becomes /pages and the NativePHP `_windowId` query parameter is dropped. */
function canonicalUrl(url: string): string {
    const parts = splitUrl(url);
    const path =
        parts.path === '' || parts.path === '/' ? '/pages' : parts.path;
    const query = new URLSearchParams(parts.query);
    query.delete('_windowId');
    const queryString = query.toString();

    return path + (queryString === '' ? '' : `?${queryString}`);
}
