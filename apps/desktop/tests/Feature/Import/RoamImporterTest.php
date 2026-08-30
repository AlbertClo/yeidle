<?php

namespace Tests\Feature\Import;

use App\DailyNotes\DailyNotes;
use App\Import\Roam\RoamAttachmentFetcher;
use App\Import\Roam\RoamContentConverter;
use App\Import\Roam\RoamExport;
use App\Import\Roam\RoamImportCancelled;
use App\Import\Roam\RoamImporter;
use App\Import\Roam\RoamImportReport;
use App\Models\Media;
use App\Models\Node;
use App\Models\NodeLink;
use App\Models\Op;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use RuntimeException;
use Tests\TestCase;

class RoamImporterTest extends TestCase
{
    use RefreshDatabase;

    private string $fixture;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        $this->fixture = base_path('tests/Fixtures/roam-export.json');
        $this->app->instance(RoamAttachmentFetcher::class, new class extends RoamAttachmentFetcher
        {
            public int $downloads = 0;

            public function fetch(string $url, string $target, int $maximumBytes): array
            {
                $this->downloads++;
                file_put_contents($target, 'sanitized image bytes');

                return ['mime_type' => 'image/png', 'size' => filesize($target)];
            }
        });
    }

    public function test_dry_run_analyses_without_writing_or_downloading(): void
    {
        $fetcher = app(RoamAttachmentFetcher::class);

        $this->artisan('roam:import', [
            'path' => $this->fixture,
            '--dry-run' => true,
        ])->assertSuccessful();

        $this->assertSame(0, Node::count());
        $this->assertSame(0, Media::count());
        $this->assertSame(0, Op::count());
        $this->assertSame(0, $fetcher->downloads);
    }

    public function test_it_imports_hierarchy_references_embeds_checkboxes_and_attachments(): void
    {
        $this->artisan('roam:import', ['path' => $this->fixture])->assertSuccessful();

        $pageId = RoamExport::nodeId('page-project');
        $referencePageId = RoamExport::nodeId('page-reference');
        $sourceId = RoamExport::nodeId('block-source');
        $embedId = RoamExport::nodeId('block-embed');
        $fileId = RoamExport::nodeId('block-file');
        $targetId = RoamExport::nodeId('block-target');
        $nestedId = RoamExport::nodeId('block-nested');

        $this->assertSame(7, Node::count());
        $this->assertSame('Project Notes', Node::findOrFail($pageId)->content);
        $this->assertSame($pageId, Node::findOrFail($sourceId)->parent_id);
        $this->assertSame('a0', Node::findOrFail($sourceId)->position);
        $this->assertSame('a1', Node::findOrFail($embedId)->position);
        $this->assertSame('a2', Node::findOrFail($fileId)->position);
        $this->assertSame($referencePageId, Node::findOrFail($targetId)->parent_id);
        $this->assertSame($targetId, Node::findOrFail($nestedId)->parent_id);
        $this->assertFalse(Node::findOrFail($sourceId)->is_checked);

        $sourceContent = Node::findOrFail($sourceId)->tiptap_content;
        $this->assertSame('paragraph', $sourceContent['type']);
        $this->assertSame('mention', $sourceContent['content'][1]['type']);
        $this->assertSame($referencePageId, $sourceContent['content'][1]['attrs']['id']);
        $this->assertSame('blockReference', $sourceContent['content'][3]['type']);
        $this->assertSame($targetId, $sourceContent['content'][3]['attrs']['targetId']);

        $embedContent = Node::findOrFail($embedId)->tiptap_content;
        $this->assertSame('blockEmbed', $embedContent['type']);
        $this->assertSame($targetId, $embedContent['attrs']['targetId']);

        $targetContent = Node::findOrFail($targetId)->tiptap_content;
        $this->assertSame('heading', $targetContent['type']);
        $this->assertSame(2, $targetContent['attrs']['level']);

        $media = Media::sole();
        $fileContent = Node::findOrFail($fileId)->tiptap_content;
        $this->assertSame('fileNode', $fileContent['type']);
        $this->assertSame($media->id, $fileContent['attrs']['mediaId']);
        $this->assertSame('diagram.png', $media->original_name);
        $this->assertSame('image/png', $media->mime_type);
        Storage::disk('local')->assertExists("media/{$media->filename}");

        $this->assertSame(3, NodeLink::count());
        $this->assertSame(8, Op::count());
    }

    public function test_repeating_the_same_import_is_idempotent(): void
    {
        $this->artisan('roam:import', ['path' => $this->fixture])->assertSuccessful();
        $this->artisan('roam:import', ['path' => $this->fixture])->assertSuccessful();

        $this->assertSame(7, Node::count());
        $this->assertSame(1, Media::count());
        $this->assertSame(8, Op::count());
        $this->assertSame(1, app(RoamAttachmentFetcher::class)->downloads);
    }

    public function test_progress_callback_can_stop_before_nodes_are_written(): void
    {
        try {
            app(RoamImporter::class)->import(
                $this->fixture,
                downloadAttachments: false,
                progress: function (string $phase, int $current): void {
                    if ($phase === 'nodes' && $current === 0) {
                        throw new RoamImportCancelled;
                    }
                },
            );

            $this->fail('The import should have been cancelled.');
        } catch (RoamImportCancelled) {
            $this->assertSame(0, Node::count());
            $this->assertSame(0, Op::count());
        }
    }

    public function test_deterministic_ids_are_namespaced_by_workspace(): void
    {
        $personal = RoamExport::fromPath($this->fixture, 'personal');
        $knowledge = RoamExport::fromPath($this->fixture, 'knowledge');

        $this->assertNotSame(
            $personal->nodeIdsByUid()['page-project'],
            $knowledge->nodeIdsByUid()['page-project'],
        );
        $this->assertNotSame(
            RoamExport::mediaId('https://files.test/image.png', 'personal'),
            RoamExport::mediaId('https://files.test/image.png', 'knowledge'),
        );
        $this->assertNotSame(
            RoamExport::opId('same-import', 'personal'),
            RoamExport::opId('same-import', 'knowledge'),
        );
    }

    public function test_roam_daily_pages_import_into_the_native_daily_note_structure(): void
    {
        $workspaceId = (string) Str::uuid7();
        $path = tempnam(sys_get_temp_dir(), 'roam-daily-');
        file_put_contents($path, json_encode([
            [
                'uid' => '08-30-2026',
                'title' => 'August 30th, 2026',
                'children' => [
                    ['uid' => 'daily-child', 'string' => 'Plan the day'],
                ],
            ],
            [
                'uid' => 'ordinary-page',
                'title' => 'Ordinary Page',
                'children' => [
                    ['uid' => 'daily-link', 'string' => 'See [[August 30th, 2026]]'],
                ],
            ],
        ], JSON_THROW_ON_ERROR));

        try {
            app(RoamImporter::class)->import(
                $path,
                downloadAttachments: false,
                workspaceId: $workspaceId,
            );
        } finally {
            @unlink($path);
        }

        $dailyId = DailyNotes::pageId($workspaceId, '2026-08-30');
        $daily = Node::findOrFail($dailyId);
        $link = Node::findOrFail(RoamExport::nodeId('daily-link', $workspaceId));

        $this->assertSame('daily_note', $daily->page_type);
        $this->assertSame('2026-08-30', $daily->daily_note_date);
        $this->assertSame('August 30, 2026', $daily->content);
        $this->assertSame($dailyId, $link->tiptap_content['content'][1]['attrs']['id']);
    }

    public function test_without_files_preserves_the_upload_as_a_web_link(): void
    {
        $this->artisan('roam:import', [
            'path' => $this->fixture,
            '--without-files' => true,
        ])->assertSuccessful();

        $this->assertSame(0, Media::count());
        $content = Node::findOrFail(RoamExport::nodeId('block-file'))->tiptap_content;
        $this->assertSame('paragraph', $content['type']);
        $this->assertSame('webLink', $content['content'][0]['type']);
    }

    public function test_failed_attachment_download_is_reported_and_remains_a_link(): void
    {
        $this->app->instance(RoamAttachmentFetcher::class, new class extends RoamAttachmentFetcher
        {
            public function fetch(string $url, string $target, int $maximumBytes): array
            {
                throw new RuntimeException('Expired source URL.');
            }
        });

        $this->artisan('roam:import', ['path' => $this->fixture])
            ->assertFailed()
            ->expectsOutputToContain('Expired source URL.');

        $this->assertSame(0, Media::count());
        $content = Node::findOrFail(RoamExport::nodeId('block-file'))->tiptap_content;
        $this->assertSame('webLink', $content['content'][0]['type']);
    }

    public function test_code_and_roam_component_names_do_not_create_unresolved_page_warnings(): void
    {
        $report = new RoamImportReport;
        $converter = new RoamContentConverter([], [], [], [], $report);
        $source = <<<'ROAM'
```css
/* Colors from [[Dracula Pro]] */
```
`[[Inline example]]`
{{[[video]]: https://files.test/example.mp4}}
Actual reference: [[Missing Page]]
ROAM;

        $converted = $converter->convert($source);

        $this->assertSame($source, $converted['content']);
        $this->assertSame(1, $report->unresolvedPageReferences);
        $this->assertSame([
            'Unresolved page reference [[Missing Page]] was preserved as text.',
        ], $report->warnings);
    }
}
