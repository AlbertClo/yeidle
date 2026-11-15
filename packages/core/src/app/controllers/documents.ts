import { invalid, json } from '../../http/http';
import type { Router } from '../../http/router';
import { isUuid } from '../../support/ids';
import { fromBase64, toBase64 } from '../../support/base64';
import type { AppContext } from '../context';

/** Loading and saving Loro documents for editor windows. */
export function registerDocumentRoutes(router: Router, ctx: AppContext): void {
    // Before documents/{id} so "changes" isn't captured as an id
    router.get('/api/documents/changes', ({ query }) =>
        json(
            ctx
                .documents()
                .store.changesSince(query.integer('since', { min: 0 })),
        ),
    );

    router.get('/api/documents/{documentId}', ({ params }) => {
        const stored = ctx.documents().store.load(params.documentId);

        return json({
            id: stored.id,
            snapshot: stored.snapshot ? toBase64(stored.snapshot) : null,
            updates: stored.updates.map(toBase64),
            seq: stored.seq,
        });
    });

    router.post('/api/documents/{documentId}/updates', ({ params, input }) => {
        const updates = input.array<Record<string, unknown>>('updates');

        if (updates.length === 0 || updates.length > 200) {
            invalid('updates', 'Send between 1 and 200 updates.');
        }

        const seq = ctx.documents().applyUpdates(
            params.documentId,
            updates.map((update, i) => {
                if (!isUuid(update.update_id)) {
                    invalid(
                        `updates.${i}.update_id`,
                        'The update id must be a UUID.',
                    );
                }

                if (
                    typeof update.origin !== 'string' ||
                    typeof update.bytes !== 'string'
                ) {
                    invalid(
                        `updates.${i}`,
                        'Each update needs an origin and bytes.',
                    );
                }

                return {
                    update_id: update.update_id,
                    origin: update.origin,
                    bytes: fromBase64(update.bytes),
                };
            }),
        );

        return json({ seq });
    });

    router.get('/api/documents/{documentId}/updates', ({ params, query }) => {
        const since = query.integer('since', { min: 0 });
        const store = ctx.documents().store;

        return json({
            updates: store
                .updatesSince(params.documentId, since)
                .map((update) => ({
                    seq: update.seq,
                    origin: update.origin,
                    bytes: toBase64(update.bytes),
                })),
            seq: Math.max(since, store.latestSeq(params.documentId)),
        });
    });
}
