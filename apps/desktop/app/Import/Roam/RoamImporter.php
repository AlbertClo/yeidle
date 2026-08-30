<?php

namespace App\Import\Roam;

use App\Models\Op;
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

        $operations = [];
        $records = $export->records();

        if ($progress) {
            $progress('nodes', 0, count($records));
        }

        foreach ($records as $index => $record) {
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

            $payload = [
                'v' => 1,
                'id' => $record['id'],
                'page_id' => $record['page_id'],
                'fields' => $fields,
            ];
            $payloadHash = hash('sha256', json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            $operations[] = [
                'op_id' => RoamExport::opId("node:{$record['uid']}:{$payloadHash}", $workspaceId),
                'client_id' => $clock->clientId,
                'hlc' => $clock->now(),
                'type' => 'node.set',
                'payload' => $payload,
            ];

            if (count($operations) === self::BATCH_SIZE || $index === array_key_last($records)) {
                if (! $dryRun) {
                    $this->pushBatch($operations, $report);
                }

                if ($progress) {
                    $progress('nodes', $index + 1, count($records));
                }
                $operations = [];
            }
        }

        return $report;
    }

    /** @param list<array<string, mixed>> $operations */
    private function pushBatch(array $operations, RoamImportReport $report): void
    {
        $opIds = array_column($operations, 'op_id');
        $alreadyImported = Op::whereIn('op_id', $opIds)->count();
        $this->sync->push($operations);
        $report->nodesAlreadyImported += $alreadyImported;
        $report->nodesWritten += count($operations) - $alreadyImported;
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
