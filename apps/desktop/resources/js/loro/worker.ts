import { readFileSync } from 'node:fs';

import { applyNodeChanges } from './nodeOps';
import type { NodeChange } from './nodeOps';
import { applyBlocks, createDoc } from './pageDoc';
import type { Block } from './pageDoc';
import { updatePageMeta } from './pageMeta';
import type { PageMeta } from './pageMeta';
import { addMedia, projectDocument } from './projection';
import type { DocumentRows, MediaRow } from './projection';

/**
 * Document worker for writes that originate in PHP (page creation, daily
 * notes, pins, preferences, imports, migration) and for projecting updates
 * that arrived from the cloud. PHP runs it as a short-lived process with a
 * JSON request on stdin and reads the JSON result from stdout.
 */

type DocumentInput = {
    id: string;
    snapshot?: string | null;
    updates?: string[];
};

type Action = {
    document_id: string;
    changes?: NodeChange[];
    replace?: { page: Partial<PageMeta>; blocks: Block[] };
    media?: MediaRow[];
};

type Request = {
    documents: DocumentInput[];
    actions?: Action[];
    message?: string;
};

type DocumentResult = {
    id: string;
    update: string | null;
    snapshot: string | null;
    rows: DocumentRows;
};

const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

export function run(request: Request): { documents: DocumentResult[] } {
    const docs = new Map(
        request.documents.map((input) => {
            const doc = createDoc();
            const blobs = [
                ...(input.snapshot ? [decode(input.snapshot)] : []),
                ...(input.updates ?? []).map(decode),
            ];

            if (blobs.length > 0) {
                doc.importBatch(blobs);
            }

            return [input.id, { doc, before: doc.oplogVersion(), imported: blobs.length }];
        }),
    );

    for (const action of request.actions ?? []) {
        let entry = docs.get(action.document_id);

        if (!entry) {
            entry = { doc: createDoc(), before: createDoc().oplogVersion(), imported: 0 };
            docs.set(action.document_id, entry);
        }

        const { doc } = entry;

        if (action.replace) {
            updatePageMeta(doc, action.replace.page);
            applyBlocks(doc, action.replace.blocks);
        }

        if (action.changes) {
            applyNodeChanges(doc, action.document_id, action.changes);
        }

        for (const media of action.media ?? []) {
            addMedia(doc, media);
        }

        if (request.message) {
            doc.setNextCommitMessage(request.message);
        }

        doc.commit();
    }

    return {
        documents: [...docs].map(([id, { doc, before, imported }]) => {
            const changed = doc.oplogVersion().compare(before) !== 0;

            return {
                id,
                update: changed
                    ? encode(doc.export({ mode: 'update', from: before }))
                    : null,
                // A fresh snapshot compacts the stored updates whenever this
                // run imported or produced more than the stored snapshot
                snapshot:
                    changed || imported > 1
                        ? encode(doc.export({ mode: 'snapshot' }))
                        : null,
                rows: projectDocument(doc, id),
            };
        }),
    };
}

if (process.argv[1]?.endsWith('loro-worker.cjs')) {
    const result = run(JSON.parse(readFileSync(0, 'utf8')) as Request);
    process.stdout.write(JSON.stringify(result));
}
