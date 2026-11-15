/**
 * A minimal request/response model for the app server. The Electron host
 * converts its protocol requests into AppRequest and AppResponse back; the
 * same handlers can run on other hosts.
 */

export type UploadedFile = { name: string; type: string; bytes: Uint8Array };

export type AppRequest = {
    method: string;
    url: URL;
    /** Lower-cased header names. */
    headers: Record<string, string>;
    /** Parsed JSON body, or form fields for multipart requests. */
    body: Record<string, unknown>;
    files: Record<string, UploadedFile>;
};

export type AppResponse = {
    status: number;
    headers: Record<string, string>;
    body:
        | string
        | Uint8Array
        | { file: string }
        | { stream: AsyncIterable<string> }
        | null;
};

export class HttpError extends Error {
    constructor(
        public status: number,
        message: string,
        public errors?: Record<string, string[]>,
    ) {
        super(message);
    }
}

export function abort(status: number, message = defaultMessage(status)): never {
    throw new HttpError(status, message);
}

export function abortIf(
    condition: unknown,
    status: number,
    message?: string,
): void {
    if (condition) {
        abort(status, message);
    }
}

function defaultMessage(status: number): string {
    return (
        {
            400: 'Bad request.',
            403: 'Forbidden.',
            404: 'Not found.',
            409: 'Conflict.',
            422: 'The given data was invalid.',
        }[status] ?? 'Server error.'
    );
}

export function json(
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
): AppResponse {
    return {
        status,
        headers: { 'content-type': 'application/json', ...headers },
        body: data === undefined ? '' : JSON.stringify(data),
    };
}

export function empty(status = 204): AppResponse {
    return { status, headers: {}, body: null };
}

export function file(
    path: string,
    contentType: string,
    headers: Record<string, string> = {},
): AppResponse {
    return {
        status: 200,
        headers: { 'content-type': contentType, ...headers },
        body: { file: path },
    };
}

export function stream(
    chunks: AsyncIterable<string>,
    contentType = 'application/x-ndjson',
): AppResponse {
    return {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'no-cache' },
        body: { stream: chunks },
    };
}

/** Laravel-style validation failure (422 with per-field messages). */
export function invalid(field: string, message: string): never {
    throw new HttpError(422, message, { [field]: [message] });
}

/** Typed accessors for request input, failing with 422 like Laravel's validator. */
export class Input {
    constructor(private data: Record<string, unknown>) {}

    has(key: string): boolean {
        return key in this.data && this.data[key] !== undefined;
    }

    raw(key: string): unknown {
        return this.data[key];
    }

    all(): Record<string, unknown> {
        return this.data;
    }

    string(key: string, options: { max?: number; min?: number } = {}): string {
        const value = this.data[key];

        if (typeof value !== 'string' || value === '') {
            invalid(key, `The ${key} field is required.`);
        }

        if (options.max !== undefined && value.length > options.max) {
            invalid(
                key,
                `The ${key} field must not be greater than ${options.max} characters.`,
            );
        }

        if (options.min !== undefined && value.length < options.min) {
            invalid(
                key,
                `The ${key} field must be at least ${options.min} characters.`,
            );
        }

        return value;
    }

    optionalString(key: string): string | null {
        const value = this.data[key];

        if (value === undefined || value === null || value === '') {
            return null;
        }

        if (typeof value !== 'string') {
            invalid(key, `The ${key} field must be a string.`);
        }

        return value;
    }

    integer(key: string, options: { min?: number; max?: number } = {}): number {
        const value = this.data[key];
        const number =
            typeof value === 'string' && value.trim() !== ''
                ? Number(value)
                : value;

        if (typeof number !== 'number' || !Number.isInteger(number)) {
            invalid(key, `The ${key} field must be an integer.`);
        }

        if (options.min !== undefined && number < options.min) {
            invalid(key, `The ${key} field must be at least ${options.min}.`);
        }

        if (options.max !== undefined && number > options.max) {
            invalid(
                key,
                `The ${key} field must not be greater than ${options.max}.`,
            );
        }

        return number;
    }

    optionalInteger(
        key: string,
        options: { min?: number; max?: number } = {},
    ): number | null {
        const value = this.data[key];

        return value === undefined || value === null || value === ''
            ? null
            : this.integer(key, options);
    }

    boolean(key: string): boolean {
        const value = this.data[key];

        if (
            value === true ||
            value === 1 ||
            value === '1' ||
            value === 'true'
        ) {
            return true;
        }

        if (
            value === false ||
            value === 0 ||
            value === '0' ||
            value === 'false'
        ) {
            return false;
        }

        invalid(key, `The ${key} field must be true or false.`);
    }

    optionalBoolean(key: string): boolean | null {
        const value = this.data[key];

        return value === undefined || value === null || value === ''
            ? null
            : this.boolean(key);
    }

    array<T = unknown>(key: string): T[] {
        const value = this.data[key];

        if (!Array.isArray(value)) {
            invalid(key, `The ${key} field must be an array.`);
        }

        return value as T[];
    }

    oneOf<T extends string>(key: string, values: readonly T[]): T {
        const value = this.string(key);

        if (!values.includes(value as T)) {
            invalid(key, `The selected ${key} is invalid.`);
        }

        return value as T;
    }
}
