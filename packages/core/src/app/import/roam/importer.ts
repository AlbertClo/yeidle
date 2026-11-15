import { placeholders } from '../../../db/database';
import type { DocumentEdit } from '../../../documents/service';
import { mergeBlocks } from '../../../loro/mergeBlocks';
import type { BlockInput } from '../../../loro/mergeBlocks';
import { updatePageMeta } from '../../../loro/pageMeta';
import type { PageMeta } from '../../../loro/pageMeta';
import type { TiptapContent } from '../../../loro/richText';
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

        // A page is always written in one go: sibling positions are only
        // comparable within one merge
        const pages = new Map<
            string,
            { meta: Partial<PageMeta> | null; blocks: BlockInput[] }
        >();

        for (const record of records) {
            const page = pages.get(record.page_id) ?? {
                meta: null,
                blocks: [],
            };
            pages.set(record.page_id, page);

            if (record.parent_id === null) {
                page.meta = {
                    title: record.content,
                    page_type:
                        record.page_type === 'daily_note' ? 'daily_note' : null,
                    daily_note_date: record.daily_note_date,
                    deleted: false,
                    ...(record.created_at !== null
                        ? { created_at: record.created_at }
                        : {}),
                };

                continue;
            }

            const converted = converter.convert(record.content, record.heading);
            page.blocks.push({
                id: record.id,
                parent_id: record.parent_id,
                position: record.position,
                tiptap_content: converted.tiptap_content as TiptapContent,
                is_checked: converted.is_checked,
                created_at: record.created_at,
            });
        }

        let batch: [
            string,
            { meta: Partial<PageMeta> | null; blocks: BlockInput[] },
        ][] = [];
        let batchSize = 0;
        let written = 0;

        const flush = async () => {
            if (!dryRun) {
                this.writeBatch(batch, report);
            }

            written += batchSize;
            batch = [];
            batchSize = 0;
            await progress?.('nodes', written, records.length);
        };

        for (const entry of pages) {
            batch.push(entry);
            batchSize += entry[1].blocks.length + (entry[1].meta ? 1 : 0);

            if (batchSize >= BATCH_SIZE) {
                await flush();
            }
        }

        if (batch.length > 0) {
            await flush();
        }

        return report;
    }

    private writeBatch(
        pages: [
            string,
            { meta: Partial<PageMeta> | null; blocks: BlockInput[] },
        ][],
        report: RoamImportReport,
    ): void {
        const db = this.ctx.db();
        const count = (table: string, ids: string[]) => {
            let found = 0;

            for (let i = 0; i < ids.length; i += 500) {
                const chunk = ids.slice(i, i + 500);
                found += db.get<{ count: number }>(
                    `SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${placeholders(chunk.length)})`,
                    chunk,
                )!.count;
            }

            return found;
        };
        const pageIds = pages
            .filter(([, page]) => page.meta !== null)
            .map(([id]) => id);
        const blockIds = pages.flatMap(([, page]) =>
            page.blocks.map((block) => block.id),
        );
        const alreadyImported =
            count('pages', pageIds) + count('blocks', blockIds);

        this.ctx.documents().editMany(
            pages.map(([pageId, page]): DocumentEdit => ({
                document_id: pageId,
                edit: (doc) => {
                    if (page.meta !== null) {
                        updatePageMeta(doc, page.meta);
                    }

                    if (page.blocks.length > 0) {
                        mergeBlocks(doc, pageId, page.blocks);
                    }
                },
            })),
            MESSAGE,
        );

        const total = pageIds.length + blockIds.length;
        report.nodesAlreadyImported += alreadyImported;
        report.nodesWritten += total - alreadyImported;
    }
}
