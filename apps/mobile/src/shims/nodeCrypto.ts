import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * The part of node:crypto the core uses (SHA-256 of media files, upload
 * ids), for the WebView. Vite aliases node:crypto to this module.
 */

type Hash = {
    update(data: Uint8Array | string): Hash;
    digest(): Uint8Array;
    digest(encoding: 'hex'): string;
};

export function createHash(algorithm: string): Hash {
    if (algorithm !== 'sha256') {
        throw new Error(`Unsupported hash algorithm: ${algorithm}`);
    }

    const state = sha256.create();
    const hash = {
        update(data: Uint8Array | string) {
            state.update(
                typeof data === 'string'
                    ? new TextEncoder().encode(data)
                    : data,
            );

            return hash;
        },
        digest(encoding?: 'hex') {
            const bytes = state.digest();

            return encoding === 'hex' ? bytesToHex(bytes) : bytes;
        },
    };

    return hash as Hash;
}

export function randomUUID(): string {
    return crypto.randomUUID();
}
