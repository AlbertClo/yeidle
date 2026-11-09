import type { AppResponse } from './http';
import type { RequestContext } from './router';

/**
 * The server side of the Inertia protocol (what inertia-laravel does), so the
 * Vue pages and @inertiajs/vue3 work unchanged.
 */

export type InertiaPage = {
    component: string;
    props: Record<string, unknown>;
    url: string;
    version: string;
    clearHistory: boolean;
    encryptHistory: boolean;
};

/** A prop computed only when it's part of the response. */
export type LazyProp = () => unknown;

export type InertiaOptions = {
    version: string;
    sharedProps: () => Record<string, unknown>;
    /** The full HTML document for a first (non-XHR) visit. */
    renderHtml: (page: InertiaPage) => string;
};

export class Inertia {
    constructor(private options: InertiaOptions) {}

    render(
        context: RequestContext,
        component: string,
        props: Record<string, unknown | LazyProp>,
        url?: string,
    ): AppResponse {
        const headers = context.request.headers;
        const pageUrl = url ?? `${context.request.url.pathname}${context.request.url.search}`;
        const all = { ...this.options.sharedProps(), ...props };
        let selected = Object.keys(all);

        if (headers['x-inertia-partial-component'] === component) {
            const only = (headers['x-inertia-partial-data'] ?? '').split(',').filter(Boolean);
            const except = (headers['x-inertia-partial-except'] ?? '').split(',').filter(Boolean);

            if (only.length > 0) {
                selected = selected.filter((key) => only.includes(key));
            }

            selected = selected.filter((key) => !except.includes(key));
        }

        const resolved: Record<string, unknown> = {};

        for (const key of selected) {
            const value = all[key];
            resolved[key] = typeof value === 'function' ? (value as LazyProp)() : value;
        }

        const page: InertiaPage = {
            component,
            props: resolved,
            url: pageUrl,
            version: this.options.version,
            clearHistory: false,
            encryptHistory: false,
        };

        if (headers['x-inertia'] === 'true') {
            if (
                context.request.method === 'GET' &&
                headers['x-inertia-version'] !== undefined &&
                headers['x-inertia-version'] !== this.options.version
            ) {
                // Asset version changed: make the client do a full reload
                return { status: 409, headers: { 'x-inertia-location': pageUrl }, body: null };
            }

            return {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-inertia': 'true',
                    vary: 'X-Inertia',
                },
                body: JSON.stringify(page),
            };
        }

        return {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: this.options.renderHtml(page),
        };
    }
}

/** Escapes a page object for the `data-page` attribute. */
export function pageAttribute(page: InertiaPage): string {
    return JSON.stringify(page)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
