import { HttpError, Input, json } from './http';
import type { AppRequest, AppResponse, UploadedFile } from './http';

export type RequestContext = {
    request: AppRequest;
    params: Record<string, string>;
    query: Input;
    input: Input;
    file(name: string): UploadedFile | null;
};

export type Handler = (context: RequestContext) => AppResponse | Promise<AppResponse>;

type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

/** Path router with `{param}` segments, matched in registration order. */
export class Router {
    private routes: Route[] = [];

    get(path: string, handler: Handler): this {
        return this.add('GET', path, handler);
    }

    post(path: string, handler: Handler): this {
        return this.add('POST', path, handler);
    }

    put(path: string, handler: Handler): this {
        return this.add('PUT', path, handler);
    }

    patch(path: string, handler: Handler): this {
        return this.add('PATCH', path, handler);
    }

    delete(path: string, handler: Handler): this {
        return this.add('DELETE', path, handler);
    }

    add(method: string, path: string, handler: Handler): this {
        const keys: string[] = [];
        const source = path
            .replace(/\/+$/, '')
            .replace(/[.*+?^$()|[\]\\]/g, '\\$&')
            .replace(/\{(\w+)\}/g, (_match, key: string) => {
                keys.push(key);

                return '([^/]+)';
            });
        this.routes.push({ method, pattern: new RegExp(`^${source || ''}/?$`), keys, handler });

        return this;
    }

    matches(request: AppRequest): boolean {
        return this.find(request) !== null;
    }

    async handle(request: AppRequest): Promise<AppResponse> {
        const found = this.find(request);

        if (found === null) {
            return json({ message: 'Not found.' }, 404);
        }

        const query = Object.fromEntries(request.url.searchParams);

        try {
            return await found.route.handler({
                request,
                params: found.params,
                query: new Input(query),
                input: new Input({ ...query, ...request.body }),
                file: (name) => request.files[name] ?? null,
            });
        } catch (error) {
            if (error instanceof HttpError) {
                return json(
                    error.errors ? { message: error.message, errors: error.errors } : { message: error.message },
                    error.status,
                );
            }

            console.error(error);

            return json({ message: error instanceof Error ? error.message : 'Server error.' }, 500);
        }
    }

    private find(request: AppRequest): { route: Route; params: Record<string, string> } | null {
        const method = request.method === 'HEAD' ? 'GET' : request.method;

        for (const route of this.routes) {
            if (route.method !== method) {
                continue;
            }

            const match = route.pattern.exec(request.url.pathname);

            if (match) {
                return {
                    route,
                    params: Object.fromEntries(
                        route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]),
                    ),
                };
            }
        }

        return null;
    }
}
