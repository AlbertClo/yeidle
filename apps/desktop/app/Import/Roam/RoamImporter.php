<?php

namespace App\Import\Roam;

use App\Models\Node;
use App\Sync\HlcGenerator;
use App\Sync\SyncService;
use Illuminate\Support\Str;

final class RoamImporter
{
    private const BATCH_SIZE = 250;

    public function __construct(
        private readonly SyncService $sync,
        private readonly RoamAttachmentImporter $attachments,
    ) {}

    /**
     * @param  null|callable(string, int, int): void  $progress
     */
    public function import(
        string $path,
        bool $dryRun = false,
        bool $downloadAttachments = true,
        string $workspaceId = 'default',
        ?callable $progress = null,
    ): RoamImportReport {
        $export = RoamExport::fromPath($path, $workspaceId);
        $report = $export->report();
        $clock = new HlcGenerator((string) Str::uuid7());
        $mediaByUrl = [];

        if (! $dryRun && $downloadAttachments) {
            $attachmentUrls = $export->attachmentUrls();

            if ($progress) {
                $progress('attachments', 0, count($attachmentUrls));
            }

            $mediaByUrl = $this->attachments->import(
                $attachmentUrls,
                $report,
                $clock,
                $workspaceId,
                function (int $current, int $total) use ($progress): void {
                    if ($progress) {
                        $progress('attachments', $current, $total);
                    }
                },
            );
        } elseif ($dryRun && $downloadAttachments) {
            foreach ($export->attachmentUrls() as $url) {
                $mediaByUrl[$url] = [
                    'id' => RoamExport::mediaId($this->canonicalUrl($url), $workspaceId),
                    'original_name' => $this->nameFromUrl($url),
                    'mime_type' => 'application/octet-stream',
                    'size' => 0,
                ];
            }
        }

        $converter = new RoamContentConverter(
            $export->pageIdsByTitle(),
            $export->nodeIdsByUid(),
            $export->nodeContentByUid(),
            $mediaByUrl,
            $report,
        );

        $records = $export->records();

        if ($progress) {
            $progress('nodes', 0, count($records));
        }

        // A page's changes are always written together: sibling positions
        // are only comparable within one write of a page document
        $changesByPage = [];

        foreach ($records as $record) {
            if ($record['parent_id'] === null) {
                $fields = [
                    'parent_id' => null,
                    'position' => $record['position'],
                    'content' => $record['content'],
                    'tiptap_content' => null,
                    'is_checked' => null,
                    'page_type' => $record['page_type'],
                    'daily_note_date' => $record['daily_note_date'],
                ];
            } else {
                $converted = $converter->convert($record['content'], $record['heading']);
                $fields = [
                    'parent_id' => $record['parent_id'],
                    'position' => $record['position'],
                    'content' => $converted['content'],
                    'tiptap_content' => $converted['tiptap_content'],
                    'is_checked' => $converted['is_checked'],
                ];
            }

            if ($record['created_at'] !== null) {
                $fields['created_at'] = $record['created_at'];
            }

            $changesByPage[$record['page_id']][] = [
                'type' => 'node.set',
                'payload' => [
                    'id' => $record['id'],
                    'page_id' => $record['page_id'],
                    'fields' => $fields,
                ],
            ];
        }

        $batch = [];
        $written = 0;

        foreach ($changesByPage as $changes) {
            $batch = [...$batch, ...$changes];

            if (count($batch) < self::BATCH_SIZE) {
                continue;
            }

            if (! $dryRun) {
                $this->pushBatch($batch, $report);
            }

            $written += count($batch);
            $batch = [];

            if ($progress) {
                $progress('nodes', $written, count($records));
            }
        }

        if ($batch !== []) {
            if (! $dryRun) {
                $this->pushBatch($batch, $report);
            }

            if ($progress) {
                $progress('nodes', count($records), count($records));
            }
        }

        return $report;
    }

    /** @param list<array<string, mixed>> $changes */
    private function pushBatch(array $changes, RoamImportReport $report): void
    {
        $ids = array_map(fn (array $change) => $change['payload']['id'], $changes);
        $alreadyImported = 0;

        foreach (array_chunk($ids, 500) as $chunk) {
            $alreadyImported += Node::whereIn('id', $chunk)->count();
        }

        $this->sync->push($changes, 'Imported from Roam Research');
        $report->nodesAlreadyImported += $alreadyImported;
        $report->nodesWritten += count($changes) - $alreadyImported;
    }

    private function canonicalUrl(string $url): string
    {
        $parts = parse_url($url);

        return sprintf(
            '%s://%s%s',
            strtolower((string) ($parts['scheme'] ?? 'https')),
            strtolower((string) ($parts['host'] ?? '')),
            (string) ($parts['path'] ?? ''),
        );
    }

    private function nameFromUrl(string $url): string
    {
        $name = basename(rawurldecode((string) parse_url($url, PHP_URL_PATH)));

        return $name !== '' ? $name : 'roam-upload';
    }
}
