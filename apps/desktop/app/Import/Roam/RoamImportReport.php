<?php

namespace App\Import\Roam;

final class RoamImportReport
{
    public int $pages = 0;

    public int $blocks = 0;

    public int $pageReferences = 0;

    public int $blockReferences = 0;

    public int $blockEmbeds = 0;

    public int $attachments = 0;

    public int $attachmentsImported = 0;

    public int $attachmentsReused = 0;

    public int $attachmentsFailed = 0;

    public int $nodesWritten = 0;

    public int $nodesAlreadyImported = 0;

    public int $unresolvedPageReferences = 0;

    public int $unresolvedBlockReferences = 0;

    public int $unsupportedMacros = 0;

    /** @var list<string> */
    public array $warnings = [];

    public function hasFailures(): bool
    {
        return $this->attachmentsFailed > 0
            || $this->unresolvedPageReferences > 0
            || $this->unresolvedBlockReferences > 0;
    }

    /** @return array<string, int> */
    public function summary(): array
    {
        return [
            'Pages' => $this->pages,
            'Blocks' => $this->blocks,
            'Page references' => $this->pageReferences,
            'Block references' => $this->blockReferences,
            'Block embeds' => $this->blockEmbeds,
            'Attachments found' => $this->attachments,
            'Attachments imported' => $this->attachmentsImported,
            'Attachments reused' => $this->attachmentsReused,
            'Attachments failed' => $this->attachmentsFailed,
            'Nodes written' => $this->nodesWritten,
            'Nodes already imported' => $this->nodesAlreadyImported,
            'Unresolved page references' => $this->unresolvedPageReferences,
            'Unresolved block references' => $this->unresolvedBlockReferences,
            'Unsupported macros preserved as text' => $this->unsupportedMacros,
        ];
    }
}
