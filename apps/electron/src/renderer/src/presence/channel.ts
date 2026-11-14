import { fromBase64, toBase64 } from '@yeidle/core/support/base64';
import type { LoroDoc } from 'loro-crdt';

import { realtimeConnection } from '@/sync/realtime';

import { PagePresence } from './pagePresence';

/**
 * A page's presence over Reverb: a presence channel per document in the
 * workspace, carrying the ephemeral store's updates as client whispers
 * (window to window through Reverb; never sent to Laravel or stored).
 */

export type PagePresenceHandle = {
    presence: PagePresence;
    leave(): void;
};

const EVENT = 'cursor';

/** Joins a page's presence channel, or null while realtime isn't connected. */
export function joinPagePresence(
    documentId: string,
    doc: () => LoroDoc,
    onChange: () => void,
): PagePresenceHandle | null {
    const connection = realtimeConnection();

    if (!connection) {
        return null;
    }

    const name = `workspaces.${connection.workspaceId}.documents.${documentId}`;
    const channel = connection.echo.join(name);
    let subscribed = false;
    const whisper = (bytes: Uint8Array) => {
        if (subscribed) {
            channel.whisper(EVENT, { b: toBase64(bytes) });
        }
    };

    const presence = new PagePresence(
        doc,
        {
            userId: connection.user?.id ?? null,
            name: connection.user?.name ?? null,
            device: connection.deviceName,
        },
        whisper,
    );
    const stopListening = presence.onChange(onChange);

    channel
        .here(() => {
            subscribed = true;
            // Announce this window to the ones already here
            whisper(presence.snapshot());
        })
        .joining(() => {
            // Bring the newcomer up to date
            whisper(presence.snapshot());
        })
        .listenForWhisper(EVENT, (event: { b?: unknown }) => {
            if (typeof event.b === 'string') {
                presence.receive(fromBase64(event.b));
            }
        });

    return {
        presence,
        leave() {
            stopListening();
            presence.leave();
            connection.echo.leave(name);
        },
    };
}
