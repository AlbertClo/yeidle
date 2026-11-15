import { uuid5 } from '../../../support/ids';
import type { Files } from '../../host';
import {
    DAILY_NOTE_PAGE_TYPE,
    dailyNotePageId,
    dailyNoteTitle,
} from '../../services/dailyNotes';
import { positionAt } from '../../services/positions';

import { RoamImportError, RoamImportReport } from './report';
import { pageReferenceCount } from './syntax';

export const ROAM_UUID_NAMESPACE = '8bf7d75e-9d19-5aca-b853-36da04773e3f';

export type RoamRecord = {
    uid: string;
    id: string;
    page_id: string;
    parent_id: string | null;
    position: string;
    content: string;
    heading: number | null;
    page_type: string | null;
    daily_note_date: string | null;
    created_at: string | null;
};

type JsonObject = Record<string, unknown>;

const FIREBASE_URL =
    /https:\/\/firebasestorage\.googleapis\.com\/[^\s)>}\]]+/gi;
const BLOCK_REFERENCE = /\(\([^)]+\)\)/g;
const BLOCK_EMBED =
    /\{\{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\([^)]+\)\)\s*\}\}/gi;
const MACRO = /\{\{[^\n]*?\}\}/g;

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A parsed Roam JSON export: every page and block flattened into records
 * with deterministic ids (uuid5 of the workspace and Roam uid, the same as
 * the PHP importer), so importing the same graph again updates in place.
 */
export class RoamExport {
    private recordList: RoamRecord[] = [];
    private idsByUid = new Map<string, string>();
    private contentByUid = new Map<string, string>();
    private idsByTitle = new Map<string, string>();
    private idsByLowerTitle = new Map<string, string>();
    private urls: string[] = [];
    private importReport = new RoamImportReport();

    private constructor(
        private pages: unknown[],
        private workspaceId: string,
    ) {
        this.index();
    }

    static fromPath(
        files: Files,
        path: string,
        workspaceId = 'default',
    ): RoamExport {
        let text: string;

        try {
            if (!files.isFile(path)) {
                throw new Error('missing');
            }

            text = files.readText(path);
        } catch {
            throw new RoamImportError(`Roam export is not readable: ${path}`);
        }

        return RoamExport.fromJson(text, workspaceId);
    }

    static fromJson(text: string, workspaceId = 'default'): RoamExport {
        let pages: unknown;

        try {
            pages = JSON.parse(text);
        } catch (error) {
            throw new RoamImportError(
                `Roam export is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            );
        }

        if (!Array.isArray(pages)) {
            throw new RoamImportError(
                'Roam export must contain a top-level JSON array.',
            );
        }

        return new RoamExport(pages, workspaceId);
    }

    static nodeId(uid: string, workspaceId = 'default'): string {
        return uuid5(
            ROAM_UUID_NAMESPACE,
            `workspace:${workspaceId}:node:${uid}`,
        );
    }

    static mediaId(canonicalUrl: string, workspaceId = 'default'): string {
        return uuid5(
            ROAM_UUID_NAMESPACE,
            `workspace:${workspaceId}:media:${canonicalUrl}`,
        );
    }

    static opId(name: string, workspaceId = 'default'): string {
        return uuid5(
            ROAM_UUID_NAMESPACE,
            `workspace:${workspaceId}:op:${name}`,
        );
    }

    records(): RoamRecord[] {
        return this.recordList;
    }

    nodeIdsByUid(): Map<string, string> {
        return this.idsByUid;
    }

    nodeContentByUid(): Map<string, string> {
        return this.contentByUid;
    }

    pageIdsByTitle(): Map<string, string> {
        return this.idsByTitle;
    }

    pageIdForTitle(title: string): string | null {
        return (
            this.idsByTitle.get(title) ??
            this.idsByLowerTitle.get(title.toLowerCase()) ??
            null
        );
    }

    attachmentUrls(): string[] {
        return this.urls;
    }

    report(): RoamImportReport {
        return this.importReport;
    }

    private index(): void {
        this.importReport.pages = this.pages.length;

        this.pages.forEach((page, pageIndex) => {
            if (!isObject(page)) {
                throw new RoamImportError(
                    `Roam page at index ${pageIndex} is not an object.`,
                );
            }

            const uid = this.requiredString(
                page,
                'uid',
                `page at index ${pageIndex}`,
            );
            const title = this.requiredString(page, 'title', `page [${uid}]`);
            const dailyNoteDate = this.dailyNoteDate(uid);
            const pageId = this.registerUid(
                uid,
                title,
                dailyNoteDate === null
                    ? null
                    : dailyNotePageId(this.workspaceId, dailyNoteDate),
            );
            this.idsByTitle.set(title, pageId);

            if (!this.idsByLowerTitle.has(title.toLowerCase())) {
                this.idsByLowerTitle.set(title.toLowerCase(), pageId);
            }

            this.recordList.push({
                uid,
                id: pageId,
                page_id: pageId,
                parent_id: null,
                position: 'a0',
                content:
                    dailyNoteDate === null
                        ? title
                        : dailyNoteTitle(dailyNoteDate),
                heading: null,
                page_type: dailyNoteDate === null ? null : DAILY_NOTE_PAGE_TYPE,
                daily_note_date: dailyNoteDate,
                created_at:
                    dailyNoteDate === null
                        ? this.createdAt(page)
                        : `${dailyNoteDate}T00:00:00.000Z`,
            });

            this.walkChildren(
                page.children ?? [],
                pageId,
                pageId,
                `page [${uid}]`,
            );
        });

        this.urls = [...new Set(this.urls)];
        this.importReport.attachments = this.urls.length;
    }

    private walkChildren(
        children: unknown,
        parentId: string,
        pageId: string,
        context: string,
    ): void {
        if (children === null) {
            return;
        }

        // PHP decoded `{}` as an empty array, which it accepted as a list
        if (isObject(children) && Object.keys(children).length === 0) {
            return;
        }

        if (!Array.isArray(children)) {
            throw new RoamImportError(
                `Roam children for ${context} must be an array.`,
            );
        }

        children.forEach((block, index) => {
            if (!isObject(block)) {
                throw new RoamImportError(
                    `Roam block ${index} under ${context} is not an object.`,
                );
            }

            const uid = this.requiredString(
                block,
                'uid',
                `block ${index} under ${context}`,
            );
            const content =
                typeof block.string === 'string' ? block.string : '';
            const id = this.registerUid(uid, content);
            this.importReport.blocks++;
            this.recordList.push({
                uid,
                id,
                page_id: pageId,
                parent_id: parentId,
                position: positionAt(index),
                content,
                heading: Number.isInteger(block.heading)
                    ? (block.heading as number)
                    : null,
                page_type: null,
                daily_note_date: null,
                created_at: this.createdAt(block),
            });

            this.analyseText(content);
            this.walkChildren(
                block.children ?? [],
                id,
                pageId,
                `block [${uid}]`,
            );
        });
    }

    private registerUid(
        uid: string,
        content: string,
        id: string | null = null,
    ): string {
        if (this.idsByUid.has(uid)) {
            throw new RoamImportError(
                `Roam export contains duplicate UID [${uid}].`,
            );
        }

        id ??= RoamExport.nodeId(uid, this.workspaceId);
        this.idsByUid.set(uid, id);
        this.contentByUid.set(uid, content);

        return id;
    }

    /** Roam names daily pages by their date, `MM-DD-YYYY`. */
    private dailyNoteDate(uid: string): string | null {
        const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(uid);

        if (match === null) {
            return null;
        }

        const month = Number(match[1]);
        const day = Number(match[2]);
        const year = Number(match[3]);
        const date = new Date(Date.UTC(2000, month - 1, day));
        date.setUTCFullYear(year);

        if (
            year < 1 ||
            date.getUTCFullYear() !== year ||
            date.getUTCMonth() !== month - 1 ||
            date.getUTCDate() !== day
        ) {
            return null;
        }

        return `${match[3]}-${match[1]}-${match[2]}`;
    }

    private createdAt(node: JsonObject): string | null {
        const milliseconds = node['create-time'];

        if (
            typeof milliseconds !== 'number' ||
            !Number.isInteger(milliseconds) ||
            milliseconds < 0
        ) {
            return null;
        }

        const date = new Date(milliseconds);

        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    private analyseText(content: string): void {
        this.importReport.pageReferences += pageReferenceCount(content);
        this.importReport.blockReferences += [
            ...content.matchAll(BLOCK_REFERENCE),
        ].length;
        this.importReport.blockEmbeds += [
            ...content.matchAll(BLOCK_EMBED),
        ].length;

        for (const match of content.matchAll(FIREBASE_URL)) {
            this.urls.push(match[0]);
        }

        for (const macro of content.matchAll(MACRO)) {
            if (!/TODO|DONE|embed/i.test(macro[0])) {
                this.importReport.unsupportedMacros++;
            }
        }
    }

    private requiredString(
        value: JsonObject,
        key: string,
        context: string,
    ): string {
        const string = value[key];

        if (typeof string !== 'string' || string === '') {
            throw new RoamImportError(
                `Roam ${context} is missing a string [${key}].`,
            );
        }

        return string;
    }
}
