import { createDoc } from '@yeidle/core/loro/pageDoc';
import { fromBase64, toBase64 } from '@yeidle/core/support/base64';
import type { LoroDoc, VersionVector } from 'loro-crdt';
import { uuidv7 } from 'uuidv7';

/**
 * An editor window's live copy of one Loro document. Local edits are
 * committed to the copy immediately and sent to the app in the background;
 * other windows' and the cloud's updates are pulled and imported. Sessions
 * are cached for the life of the window so returning to a page is instant.
 */

export type DocumentState = {
    id: string;
    snapshot: string | null;
    updates: string[];
    seq: number;
};

// One writer identity per window session
const clientId = uuidv7();
const sessions = new Map<string, DocumentSession>();

export class DocumentSession {
    readonly doc: LoroDoc;
    /** Highest local sequence imported from the app. */
    private seq = 0;
    /** What the app has of this document's changes from this window. */
    private sentVersion: VersionVector;
    private sending: Promise<boolean> | null = null;
    private resend = false;

    private constructor(readonly id: string) {
        this.doc = createDoc();
        this.sentVersion = this.doc.oplogVersion();
    }

    /** The cached session, brought up to date with a state from the app. */
    static fromState(state: DocumentState): DocumentSession {
        let session = sessions.get(state.id);

        if (!session) {
            session = new DocumentSession(state.id);
            sessions.set(state.id, session);
        }

        session.importState(state);

        return session;
    }

    static async open(id: string): Promise<DocumentSession> {
        const cached = sessions.get(id);

        if (cached) {
            return cached;
        }

        const response = await fetch(`/api/documents/${id}`, {
            headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
            throw new Error(`Could not load document ${id}.`);
        }

        return DocumentSession.fromState(
            (await response.json()) as DocumentState,
        );
    }

    static cached(id: string): DocumentSession | null {
        return sessions.get(id) ?? null;
    }

    hasUnsentChanges(): boolean {
        return this.doc.oplogVersion().compare(this.sentVersion) !== 0;
    }

    /** Runs a local change; commits and sends it if anything changed. */
    change(mutate: (doc: LoroDoc) => boolean): boolean {
        const changed = mutate(this.doc);

        if (changed) {
            this.doc.commit();
            void this.send();
        }

        return changed;
    }

    /** Sends unsent local changes. Resolves false if the app couldn't take them. */
    send(): Promise<boolean> {
        if (this.sending) {
            this.resend = true;

            return this.sending;
        }

        this.sending = this.sendNow().finally(() => {
            this.sending = null;

            if (this.resend) {
                this.resend = false;
                void this.send();
            }
        });

        return this.sending;
    }

    /**
     * Fetches updates from the app that this window doesn't have yet. The
     * returned function imports them; callers run it synchronously together
     * with their own local flush so the editor and the document never
     * disagree in between.
     */
    async fetchUpdates(): Promise<(() => boolean) | null> {
        const response = await fetch(
            `/api/documents/${this.id}/updates?since=${this.seq}`,
            {
                headers: { Accept: 'application/json' },
            },
        );

        if (!response.ok) {
            return null;
        }

        const data = (await response.json()) as {
            updates: { seq: number; client_id: string; bytes: string }[];
            seq: number;
        };

        return () => {
            const before = this.doc.oplogVersion();
            const hadUnsent = this.hasUnsentChanges();
            const foreign = data.updates.filter(
                (update) => update.client_id !== clientId,
            );

            if (foreign.length > 0) {
                this.doc.importBatch(
                    foreign.map((update) => fromBase64(update.bytes)),
                );
            }

            // The app already has what was just imported
            if (!hadUnsent) {
                this.sentVersion = this.doc.oplogVersion();
            }

            this.seq = Math.max(this.seq, data.seq);

            return this.doc.oplogVersion().compare(before) !== 0;
        };
    }

    private importState(state: DocumentState): void {
        const blobs = [
            ...(state.snapshot ? [state.snapshot] : []),
            ...state.updates,
        ].map(fromBase64);
        const hadUnsent = this.hasUnsentChanges();

        if (blobs.length > 0) {
            this.doc.importBatch(blobs);
        }

        if (!hadUnsent) {
            this.sentVersion = this.doc.oplogVersion();
        }

        this.seq = Math.max(this.seq, state.seq);
    }

    private async sendNow(): Promise<boolean> {
        const target = this.doc.oplogVersion();

        if (target.compare(this.sentVersion) === 0) {
            return true;
        }

        const bytes = this.doc.export({
            mode: 'update',
            from: this.sentVersion,
        });

        try {
            const response = await fetch(`/api/documents/${this.id}/updates`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    updates: [
                        {
                            update_id: uuidv7(),
                            client_id: clientId,
                            bytes: toBase64(bytes),
                        },
                    ],
                }),
            });

            if (!response.ok) {
                return false;
            }
        } catch {
            return false;
        }

        this.sentVersion = target;

        return true;
    }
}

/** Sends every cached session's unsent changes (before unload, on blur). */
export function sendAllSessions(): Promise<boolean[]> {
    return Promise.all([...sessions.values()].map((session) => session.send()));
}
