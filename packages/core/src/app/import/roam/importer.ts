import { placeholders } from '../../../db/database';
import type { Change } from '../../../documents/service';
import type { AppContext } from '../../context';

import { canonicalUrl, RoamAttachmentImporter } from './attachments';
import {
    basename,
    rawUrlDecode,
    RoamContentConverter,
    urlPath,
} from './contentConverter';
import type { MediaDescriptor } from './contentConverter';
import { RoamExport } from './export';
import type { RoamImportReport } from './report';

export type RoamImportPhase = 'attachments' | 'nodes';

export type RoamProgress = (
    phase: RoamImportPhase,
    current: number,
    total: number,
) => void | Promise<void>;

export type RoamImportOptions = {
    dryRun?: boolean;
    downloadAttachments?: boolean;
    /** Namespaces the deterministic ids; the target workspace's id. */
    workspaceId?: string;
    /** May throw RoamImportCancelled to stop the import. */
    progress?: RoamProgress | null;
};

const BATCH_SIZE = 250;
const MESSAGE = 'Imported from Roam Research';

/**
 * Imports a Roam JSON export into the context's workspace. Ids are
 * deterministic, so importing the same export again updates the same nodes
 * and writes nothing when nothing changed.
 */
export class RoamImporter {
    constructor(
        private ctx: AppContext,
        private attachments: RoamAttachmentImporter = new RoamAttachmentImporter(
            ctx,
        ),
    ) {}

    async import(
        path: string,
        options: RoamImportOptions = {},
    ): Promise<RoamImportReport> {
        const dryRun = options.dryRun ?? false;
        const downloadAttachments = options.downloadAttachments ?? true;
        const workspaceId = options.workspaceId ?? 'default';
        const progress = options.progress ?? null;
        const exported = RoamExport.fromPath(
            this.ctx.host.files,
            path,
            workspaceId,
        );
        const report = exported.report();
        let mediaByUrl = new Map<string, MediaDescriptor>();

        if (!dryRun && downloadAttachments) {
            const urls = exported.attachmentUrls();
            await progress?.('attachments', 0, urls.length);
            mediaByUrl = await this.attachments.import(
                urls,
                report,
                workspaceId,
                (current, total) => progress?.('attachments', current, total),
            );
        } else if (dryRun && downloadAttachments) {
            for (const url of exported.attachmentUrls()) {
                const name = basename(rawUrlDecode(urlPath(url)));
                mediaByUrl.set(url, {
                    id: RoamExport.mediaId(canonicalUrl(url), workspaceId),
                    original_name: name !== '' ? name : 'roam-upload',
                    mime_type: 'application/octet-stream',
                    size: 0,
                });
            }
        }

        const converter = new RoamContentConverter(
            exported.pageIdsByTitle(),
            exported.nodeIdsByUid(),
            exported.nodeContentByUid(),
            mediaByUrl,
            report,
        );
        const records = exported.records();
        await progress?.('nodes', 0, records.length);

        // A page's changes are always written together: sibling positions
        // are only comparable within one write of a page document
        const changesByPage = new Map<string, Change[]>();

        for (const record of records) {
            let fields: Record<string, unknown>;

            if (record.parent_id === null) {
                fields = {
                    parent_id: null,
                    position: record.position,
                    content: record.content,
                    tiptap_content: null,
                    is_checked: null,
                    page_type: record.page_type,
                    daily_note_date: record.daily_note_date,
                };
            } else {
                const converted = converter.convert(
                    record.content,
                    record.heading,
                );
                fields = {
                    parent_id: record.parent_id,
                    position: record.position,
                    content: converted.content,
                    tiptap_content: converted.tiptap_content,
                    is_checked: converted.is_checked,
                };
            }

            if (record.created_at !== null) {
                fields.created_at = record.created_at;
            }

            const changes = changesByPage.get(record.page_id) ?? [];
            changes.push({
                type: 'node.set',
                payload: { id: record.id, page_id: record.page_id, fields },
            });
            changesByPage.set(record.page_id, changes);
        }

        let batch: Change[] = [];
        let written = 0;

        for (const changes of changesByPage.values()) {
            batch.push(...changes);

            if (batch.length < BATCH_SIZE) {
                continue;
            }

            if (!dryRun) {
                this.writeBatch(batch, report);
            }

            written += batch.length;
            batch = [];
            await progress?.('nodes', written, records.length);
        }

        if (batch.length > 0) {
            if (!dryRun) {
                this.writeBatch(batch, report);
            }

            await progress?.('nodes', records.length, records.length);
        }

        return report;
    }

    private writeBatch(changes: Change[], report: RoamImportReport): void {
        const ids = changes.map(
            (change) => (change.payload as { id: string }).id,
        );
        let alreadyImported = 0;

        for (let i = 0; i < ids.length; i += 500) {
            const chunk = ids.slice(i, i + 500);
            alreadyImported += this.ctx
                .db()
                .get<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM nodes WHERE deleted_at IS NULL AND id IN (${placeholders(chunk.length)})`,
                    chunk,
                )!.count;
        }

        this.ctx.documents().applyChanges(changes, MESSAGE);
        report.nodesAlreadyImported += alreadyImported;
        report.nodesWritten += changes.length - alreadyImported;
    }
}
