import { v5 } from 'uuid';
import { uuidv7 } from 'uuidv7';

export { uuidv7 };

/** Name-based UUID (version 5), matching Ramsey's Uuid::uuid5 in the PHP app. */
export function uuid5(namespace: string, name: string): string {
    return v5(name, namespace);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}
