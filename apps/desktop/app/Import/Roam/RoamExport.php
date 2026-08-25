<?php

namespace App\Import\Roam;

use JsonException;
use Ramsey\Uuid\Uuid;
use RuntimeException;

final class RoamExport
{
    public const UUID_NAMESPACE = '8bf7d75e-9d19-5aca-b853-36da04773e3f';

    /** @var list<array{uid: string, id: string, page_id: string, parent_id: ?string, position: string, content: string, heading: ?int}> */
    private array $records = [];

    /** @var array<string, string> */
    private array $nodeIdsByUid = [];

    /** @var array<string, string> */
    private array $nodeContentByUid = [];

    /** @var array<string, string> */
    private array $pageIdsByTitle = [];

    /** @var array<string, string> */
    private array $pageIdsByLowerTitle = [];

    /** @var list<string> */
    private array $attachmentUrls = [];

    private RoamImportReport $report;

    /** @param list<array<string, mixed>> $pages */
    private function __construct(
        private readonly array $pages,
        private readonly string $workspaceId,
    ) {
        $this->report = new RoamImportReport;
        $this->index();
    }

    public static function fromPath(string $path, string $workspaceId = 'default'): self
    {
        if (! is_file($path) || ! is_readable($path)) {
            throw new RuntimeException("Roam export is not readable: {$path}");
        }

        try {
            $pages = json_decode(file_get_contents($path), true, flags: JSON_THROW_ON_ERROR);
        } catch (JsonException $exception) {
            throw new RuntimeException('Roam export is not valid JSON: '.$exception->getMessage(), previous: $exception);
        }

        if (! is_array($pages) || ! array_is_list($pages)) {
            throw new RuntimeException('Roam export must contain a top-level JSON array.');
        }

        return new self($pages, $workspaceId);
    }

    /** @return list<array{uid: string, id: string, page_id: string, parent_id: ?string, position: string, content: string, heading: ?int}> */
    public function records(): array
    {
        return $this->records;
    }

    /** @return array<string, string> */
    public function nodeIdsByUid(): array
    {
        return $this->nodeIdsByUid;
    }

    /** @return array<string, string> */
    public function nodeContentByUid(): array
    {
        return $this->nodeContentByUid;
    }

    /** @return array<string, string> */
    public function pageIdsByTitle(): array
    {
        return $this->pageIdsByTitle;
    }

    public function pageIdForTitle(string $title): ?string
    {
        return $this->pageIdsByTitle[$title]
            ?? $this->pageIdsByLowerTitle[mb_strtolower($title)]
            ?? null;
    }

    /** @return list<string> */
    public function attachmentUrls(): array
    {
        return $this->attachmentUrls;
    }

    public function report(): RoamImportReport
    {
        return $this->report;
    }

    public static function nodeId(string $uid, string $workspaceId = 'default'): string
    {
        return Uuid::uuid5(self::UUID_NAMESPACE, "workspace:{$workspaceId}:node:{$uid}")->toString();
    }

    public static function mediaId(string $canonicalUrl, string $workspaceId = 'default'): string
    {
        return Uuid::uuid5(self::UUID_NAMESPACE, "workspace:{$workspaceId}:media:{$canonicalUrl}")->toString();
    }

    public static function opId(string $name, string $workspaceId = 'default'): string
    {
        return Uuid::uuid5(self::UUID_NAMESPACE, "workspace:{$workspaceId}:op:{$name}")->toString();
    }

    private function index(): void
    {
        $this->report->pages = count($this->pages);

        foreach ($this->pages as $pageIndex => $page) {
            if (! is_array($page)) {
                throw new RuntimeException("Roam page at index {$pageIndex} is not an object.");
            }

            $uid = $this->requiredString($page, 'uid', "page at index {$pageIndex}");
            $title = $this->requiredString($page, 'title', "page [{$uid}]");
            $pageId = $this->registerUid($uid, $title);
            $this->pageIdsByTitle[$title] = $pageId;
            $this->pageIdsByLowerTitle[mb_strtolower($title)] ??= $pageId;
            $this->records[] = [
                'uid' => $uid,
                'id' => $pageId,
                'page_id' => $pageId,
                'parent_id' => null,
                'position' => 'a0',
                'content' => $title,
                'heading' => null,
            ];

            $this->walkChildren($page['children'] ?? [], $pageId, $pageId, "page [{$uid}]");
        }

        $this->attachmentUrls = array_values(array_unique($this->attachmentUrls));
        $this->report->attachments = count($this->attachmentUrls);
    }

    private function walkChildren(mixed $children, string $parentId, string $pageId, string $context): void
    {
        if ($children === null) {
            return;
        }

        if (! is_array($children) || ! array_is_list($children)) {
            throw new RuntimeException("Roam children for {$context} must be an array.");
        }

        foreach ($children as $index => $block) {
            if (! is_array($block)) {
                throw new RuntimeException("Roam block {$index} under {$context} is not an object.");
            }

            $uid = $this->requiredString($block, 'uid', "block {$index} under {$context}");
            $content = isset($block['string']) && is_string($block['string']) ? $block['string'] : '';
            $id = $this->registerUid($uid, $content);
            $this->report->blocks++;
            $this->records[] = [
                'uid' => $uid,
                'id' => $id,
                'page_id' => $pageId,
                'parent_id' => $parentId,
                'position' => RoamPosition::at($index),
                'content' => $content,
                'heading' => isset($block['heading']) && is_int($block['heading']) ? $block['heading'] : null,
            ];

            $this->analyseText($content);
            $this->walkChildren($block['children'] ?? [], $id, $pageId, "block [{$uid}]");
        }
    }

    private function registerUid(string $uid, string $content): string
    {
        if (isset($this->nodeIdsByUid[$uid])) {
            throw new RuntimeException("Roam export contains duplicate UID [{$uid}].");
        }

        $id = self::nodeId($uid, $this->workspaceId);
        $this->nodeIdsByUid[$uid] = $id;
        $this->nodeContentByUid[$uid] = $content;

        return $id;
    }

    private function analyseText(string $content): void
    {
        $this->report->pageReferences += RoamSyntax::pageReferenceCount($content);
        $this->report->blockReferences += preg_match_all('/\(\([^\)]+\)\)/u', $content);
        $this->report->blockEmbeds += preg_match_all('/\{\{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\([^\)]+\)\)\s*\}\}/iu', $content);

        if (preg_match_all('~https://firebasestorage\.googleapis\.com/[^\s)>}\]]+~iu', $content, $matches)) {
            array_push($this->attachmentUrls, ...$matches[0]);
        }

        if (preg_match_all('/\{\{.*?\}\}/u', $content, $macros)) {
            foreach ($macros[0] as $macro) {
                if (! preg_match('/(?:TODO|DONE|embed)/iu', $macro)) {
                    $this->report->unsupportedMacros++;
                }
            }
        }
    }

    /** @param array<string, mixed> $value */
    private function requiredString(array $value, string $key, string $context): string
    {
        if (! isset($value[$key]) || ! is_string($value[$key]) || $value[$key] === '') {
            throw new RuntimeException("Roam {$context} is missing a string [{$key}].");
        }

        return $value[$key];
    }
}
