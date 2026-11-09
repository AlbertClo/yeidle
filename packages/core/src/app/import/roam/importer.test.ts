import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { uuidv7 } from '../../../support/ids';
import { dailyNotePageId } from '../../services/dailyNotes';
import { testContext } from '../../testing';

import { canonicalUrl, RoamAttachmentFetcher } from './attachments';
import type { Download } from './attachments';
import { RoamContentConverter } from './contentConverter';
import { RoamExport } from './export';
import { importRoamFile } from './importRoamFile';
import { RoamImporter } from './importer';
import { RoamImportCancelled, RoamImportReport } from './report';
import { pageReferenceCount } from './syntax';

const fixture = fileURLToPath(
    new URL('./fixtures/roam-export.json', import.meta.url),
);

class FakeFetcher extends RoamAttachmentFetcher {
    downloads = 0;

    constructor(private failure: string | null = null) {
        super(null as never, 0);
    }

    override async fetch(): Promise<Download> {
        if (this.failure !== null) {
            throw new Error(this.failure);
        }

        this.downloads++;
        const bytes = new TextEncoder().encode('sanitized image bytes');

        return { bytes, mime_type: 'image/png', size: bytes.byteLength };
    }
}

type NodeRow = {
    id: string;
    parent_id: string | null;
    position: string;
    content: string;
    tiptap_content: string | null;
    is_checked: number | null;
    created_at: string | null;
    page_type: string | null;
    daily_note_date: string | null;
};

let ctx: ReturnType<typeof testContext>;
let fetcher: FakeFetcher;
let workspaceId: string;

beforeEach(() => {
    ctx = testContext();
    fetcher = new FakeFetcher();
    workspaceId = ctx.workspace().id;
});

afterEach(() => ctx.cleanup());

function count(table: string): number {
    return ctx
        .db()
        .get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)!
        .count;
}

function nodeCount(): number {
    return ctx
        .db()
        .get<{ count: number }>(
            'SELECT COUNT(*) AS count FROM nodes WHERE deleted_at IS NULL',
        )!.count;
}

function node(uid: string, workspace = workspaceId): NodeRow {
    const row = ctx
        .db()
        .get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [
            RoamExport.nodeId(uid, workspace),
        ]);
    expect(row, `node ${uid}`).toBeDefined();

    return row!;
}

function tiptap(row: NodeRow): any {
    return JSON.parse(row.tiptap_content!);
}

describe('Roam importer', () => {
    it('analyses a dry run without writing or downloading', async () => {
        const result = await importRoamFile(ctx, fixture, {
            dryRun: true,
            fetcher,
        });

        expect(result.success).toBe(true);
        expect(result.report.pages).toBe(2);
        expect(result.report.blocks).toBe(5);
        expect(nodeCount()).toBe(0);
        expect(count('media')).toBe(0);
        expect(count('document_updates')).toBe(0);
        expect(fetcher.downloads).toBe(0);
    });

    it('imports hierarchy, references, embeds, checkboxes and attachments', async () => {
        const result = await importRoamFile(ctx, fixture, { fetcher });
        expect(result.success).toBe(true);
        expect(result.report.nodesWritten).toBe(7);

        const page = node('page-project');
        const referencePageId = RoamExport.nodeId(
            'page-reference',
            workspaceId,
        );
        const source = node('block-source');
        const target = node('block-target');

        expect(nodeCount()).toBe(7);
        expect(page.content).toBe('Project Notes');
        expect(page.created_at).toBe('2021-01-01 00:00:00');
        expect(source.parent_id).toBe(page.id);
        expect(source.created_at).toBe('2021-01-02 00:00:00');
        expect(source.position).toBe('a0');
        expect(node('block-embed').position).toBe('a1');
        expect(node('block-file').position).toBe('a2');
        expect(target.parent_id).toBe(referencePageId);
        expect(node('block-nested').parent_id).toBe(target.id);
        expect(source.is_checked).toBe(0);

        const sourceContent = tiptap(source);
        expect(sourceContent.type).toBe('paragraph');
        expect(sourceContent.content[1].type).toBe('mention');
        expect(sourceContent.content[1].attrs.id).toBe(referencePageId);
        expect(sourceContent.content[3].type).toBe('blockReference');
        expect(sourceContent.content[3].attrs.targetId).toBe(target.id);

        const embedContent = tiptap(node('block-embed'));
        expect(embedContent.type).toBe('blockEmbed');
        expect(embedContent.attrs.targetId).toBe(target.id);

        const targetContent = tiptap(target);
        expect(targetContent.type).toBe('heading');
        expect(targetContent.attrs.level).toBe(2);

        const media = ctx
            .db()
            .all<{
                id: string;
                filename: string;
                original_name: string;
                mime_type: string;
            }>('SELECT * FROM media');
        expect(media).toHaveLength(1);
        const fileContent = tiptap(node('block-file'));
        expect(fileContent.type).toBe('fileNode');
        expect(fileContent.attrs.mediaId).toBe(media[0].id);
        expect(media[0].original_name).toBe('diagram.png');
        expect(media[0].mime_type).toBe('image/png');
        expect(
            fs.existsSync(
                path.join(
                    ctx.workspace().storagePath,
                    'media',
                    media[0].filename,
                ),
            ),
        ).toBe(true);

        expect(count('node_links')).toBe(3);
        // One document per page plus the media document
        expect(count('documents')).toBe(3);
    });

    it('is idempotent when the same import is repeated', async () => {
        await importRoamFile(ctx, fixture, { fetcher });
        const updates = count('document_updates');
        const second = await importRoamFile(ctx, fixture, { fetcher });

        expect(nodeCount()).toBe(7);
        expect(count('media')).toBe(1);
        // Nothing changed, so the second run wrote no updates
        expect(count('document_updates')).toBe(updates);
        expect(fetcher.downloads).toBe(1);
        expect(second.report.nodesWritten).toBe(0);
        expect(second.report.nodesAlreadyImported).toBe(7);
        expect(second.report.attachmentsReused).toBe(1);
    });

    it('can be stopped by the progress callback before nodes are written', async () => {
        await expect(
            new RoamImporter(ctx).import(fixture, {
                downloadAttachments: false,
                progress: (phase, current) => {
                    if (phase === 'nodes' && current === 0) {
                        throw new RoamImportCancelled();
                    }
                },
            }),
        ).rejects.toBeInstanceOf(RoamImportCancelled);

        expect(nodeCount()).toBe(0);
        expect(count('document_updates')).toBe(0);
    });

    it('namespaces deterministic ids by workspace', () => {
        const text = fs.readFileSync(fixture, 'utf8');
        const personal = RoamExport.fromJson(text, 'personal');
        const knowledge = RoamExport.fromJson(text, 'knowledge');

        expect(personal.nodeIdsByUid().get('page-project')).not.toBe(
            knowledge.nodeIdsByUid().get('page-project'),
        );
        expect(
            RoamExport.mediaId('https://files.test/image.png', 'personal'),
        ).not.toBe(
            RoamExport.mediaId('https://files.test/image.png', 'knowledge'),
        );
        expect(RoamExport.opId('same-import', 'personal')).not.toBe(
            RoamExport.opId('same-import', 'knowledge'),
        );
    });

    it('produces the same ids as the PHP importer', () => {
        // Computed with Ramsey\Uuid::uuid5 in the NativePHP app
        expect(RoamExport.nodeId('page-project')).toBe(
            'e2bbcce0-cea1-5fe4-9b93-f185f0936f05',
        );
        expect(
            RoamExport.mediaId(
                canonicalUrl(
                    'https://firebasestorage.googleapis.com/v0/b/example/o/users%2Fdemo%2Fdiagram.png?alt=media&token=test',
                ),
                'ws-1',
            ),
        ).toBe('97a3a884-5475-563f-88e6-38a42967e51c');
        expect(dailyNotePageId('ws-1', '2026-08-30')).toBe(
            '4bfaf4e2-aa10-598d-a032-043ab843392f',
        );
    });

    it('imports Roam daily pages into the native daily note structure', async () => {
        const otherWorkspace = uuidv7();
        const file = path.join(
            fs.mkdtempSync(path.join(os.tmpdir(), 'roam-daily-')),
            'export.json',
        );
        fs.writeFileSync(
            file,
            JSON.stringify([
                {
                    uid: '08-30-2026',
                    title: 'August 30th, 2026',
                    'create-time': 1609459200123,
                    children: [{ uid: 'daily-child', string: 'Plan the day' }],
                },
                {
                    uid: 'ordinary-page',
                    title: 'Ordinary Page',
                    'create-time': 1609545600456,
                    children: [
                        {
                            uid: 'daily-link',
                            string: 'See [[August 30th, 2026]]',
                            'create-time': 1609632000789,
                        },
                    ],
                },
            ]),
        );

        try {
            await new RoamImporter(ctx).import(file, {
                downloadAttachments: false,
                workspaceId: otherWorkspace,
            });
        } finally {
            fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }

        const dailyId = dailyNotePageId(otherWorkspace, '2026-08-30');
        const daily = ctx
            .db()
            .get<NodeRow>('SELECT * FROM nodes WHERE id = ?', [dailyId])!;
        const ordinary = node('ordinary-page', otherWorkspace);
        const link = node('daily-link', otherWorkspace);

        expect(daily.page_type).toBe('daily_note');
        expect(daily.daily_note_date).toBe('2026-08-30');
        expect(daily.created_at?.slice(0, 10)).toBe('2026-08-30');
        expect(daily.content).toBe('August 30, 2026');
        expect(ordinary.created_at).toBe('2021-01-02 00:00:00');
        expect(link.created_at).toBe('2021-01-03 00:00:00');
        expect(tiptap(link).content[1].attrs.id).toBe(dailyId);
    });

    it('preserves the upload as a web link without files', async () => {
        await importRoamFile(ctx, fixture, { withoutFiles: true, fetcher });

        expect(count('media')).toBe(0);
        const content = tiptap(node('block-file'));
        expect(content.type).toBe('paragraph');
        expect(content.content[0].type).toBe('webLink');
    });

    it('reports a failed attachment download and keeps it as a link', async () => {
        const result = await importRoamFile(ctx, fixture, {
            fetcher: new FakeFetcher('Expired source URL.'),
        });

        expect(result.success).toBe(false);
        expect(result.report.attachmentsFailed).toBe(1);
        expect(result.report.warnings.join('\n')).toContain(
            'Expired source URL.',
        );
        expect(count('media')).toBe(0);
        expect(tiptap(node('block-file')).content[0].type).toBe('webLink');
    });

    it('downloads attachments through the host', async () => {
        const url =
            'https://firebasestorage.googleapis.com/v0/b/example/o/users%2Fdemo%2Fdiagram.png?alt=media&token=test';
        ctx.downloads.set(url, {
            contentType: 'application/octet-stream',
            bytes: new Uint8Array([
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
            ]),
        });

        const result = await importRoamFile(ctx, fixture);

        expect(result.report.attachmentsImported).toBe(1);
        expect(
            ctx.db().get<{ mime_type: string }>('SELECT mime_type FROM media')!
                .mime_type,
        ).toBe('image/png');
    });
});

describe('Roam content converter', () => {
    const converter = (report: RoamImportReport) =>
        new RoamContentConverter(
            new Map(),
            new Map(),
            new Map(),
            new Map(),
            report,
        );

    it('does not warn about code and Roam component names', () => {
        const report = new RoamImportReport();
        const source = [
            '```css',
            '/* Colors from [[Dracula Pro]] */',
            '```',
            '`[[Inline example]]`',
            '{{[[video]]: https://files.test/example.mp4}}',
            'Actual reference: [[Missing Page]]',
        ].join('\n');

        const converted = converter(report).convert(source);

        expect(converted.content).toBe(source);
        expect(report.unresolvedPageReferences).toBe(1);
        expect(report.warnings).toEqual([
            'Unresolved page reference [[Missing Page]] was preserved as text.',
        ]);
    });

    it('imports inline code as code marks', () => {
        const report = new RoamImportReport();
        const source = 'replace `composer dev` with `php artisan dev`';

        const converted = converter(report).convert(source);

        expect(converted.content).toBe(source);
        expect(converted.tiptap_content).toEqual({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'replace ' },
                {
                    type: 'text',
                    text: 'composer dev',
                    marks: [{ type: 'code' }],
                },
                { type: 'text', text: ' with ' },
                {
                    type: 'text',
                    text: 'php artisan dev',
                    marks: [{ type: 'code' }],
                },
            ],
        });
    });

    it('imports fenced code as a multiline code block', () => {
        const report = new RoamImportReport();
        const source = [
            'Before',
            '```php',
            '$message = "Hello";',
            'echo $message;',
            '```',
            'After',
        ].join('\n');

        const converted = converter(report).convert(source);

        expect(converted.content).toBe(source);
        expect(converted.tiptap_content).toEqual([
            { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
            {
                type: 'codeBlock',
                attrs: { language: 'php' },
                content: [
                    {
                        type: 'text',
                        text: '$message = "Hello";\necho $message;',
                    },
                ],
            },
            { type: 'paragraph', content: [{ type: 'text', text: 'After' }] },
        ]);
        expect(report.unresolvedPageReferences).toBe(0);
    });
});

describe('Roam syntax', () => {
    it('counts page references outside code and Roam component names', () => {
        const source = [
            '```css',
            '/* Colors from [[Dracula Pro]] */',
            '```',
            '`[[Inline example]]`',
            '{{[[video]]: https://files.test/example.mp4}}',
            '{{ [[query]]: {and: [[Included Query Argument]]} }}',
            '[[Actual Page]]',
        ].join('\n');

        expect(pageReferenceCount(source)).toBe(2);
    });
});
