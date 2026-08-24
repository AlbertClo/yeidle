<?php

namespace App\Import\Roam;

final class RoamContentConverter
{
    /** @var array<string, true> */
    private array $warnedPageReferences = [];

    /** @var array<string, true> */
    private array $warnedBlockReferences = [];

    /**
     * @param  array<string, string>  $pageIdsByTitle
     * @param  array<string, string>  $nodeIdsByUid
     * @param  array<string, string>  $nodeContentByUid
     * @param  array<string, array{id: string, original_name: string, mime_type: string, size: int}>  $mediaByUrl
     */
    public function __construct(
        private readonly array $pageIdsByTitle,
        private readonly array $nodeIdsByUid,
        private readonly array $nodeContentByUid,
        private readonly array $mediaByUrl,
        private readonly RoamImportReport $report,
    ) {}

    /** @return array{content: string, tiptap_content: array<string, mixed>|list<array<string, mixed>>, is_checked: ?bool} */
    public function convert(string $source, ?int $heading = null): array
    {
        [$source, $checked] = $this->extractCheckbox($source);
        $blocks = [];
        $tokens = $this->blockTokens($source);
        $cursor = 0;
        $plainContent = '';

        foreach ($tokens as $token) {
            $before = substr($source, $cursor, $token['offset'] - $cursor);
            $plainContent .= $before;
            $this->appendParagraph($blocks, $before, $heading);
            $heading = null;

            if ($token['type'] === 'embed') {
                $targetId = $this->nodeIdsByUid[$token['uid']] ?? null;

                if ($targetId) {
                    $blocks[] = [
                        'type' => 'blockEmbed',
                        'attrs' => [
                            'targetId' => $targetId,
                            'targetUid' => $token['uid'],
                            'fallback' => $this->fallbackForUid($token['uid']),
                        ],
                    ];
                } else {
                    $this->report->unresolvedBlockReferences++;
                    $this->warnAboutBlockReference($token['uid']);
                    $this->appendParagraph($blocks, $token['raw'], null);
                }

                $plainContent .= $token['raw'];
            } else {
                $media = $this->mediaByUrl[$token['url']] ?? null;

                if ($media) {
                    $blocks[] = [
                        'type' => 'fileNode',
                        'attrs' => [
                            'mediaId' => $media['id'],
                            'src' => "/api/media/{$media['id']}",
                            'originalName' => $media['original_name'],
                            'mimeType' => $media['mime_type'],
                            'size' => $media['size'],
                        ],
                    ];
                    $plainContent .= "[{$media['original_name']}]";
                } else {
                    $label = $token['label'] !== '' ? $token['label'] : $this->nameFromUrl($token['url']);
                    $blocks[] = $this->paragraph([[
                        'type' => 'webLink',
                        'attrs' => ['href' => $token['url'], 'label' => $label],
                    ]], null);
                    $plainContent .= $token['raw'];
                }
            }

            $cursor = $token['offset'] + $token['length'];
        }

        $tail = substr($source, $cursor);
        $plainContent .= $tail;
        $this->appendParagraph($blocks, $tail, $heading);

        if ($blocks === []) {
            $blocks[] = $this->paragraph([], $heading);
        }

        return [
            'content' => $plainContent,
            'tiptap_content' => count($blocks) === 1 ? $blocks[0] : $blocks,
            'is_checked' => $checked,
        ];
    }

    /** @return array{0: string, 1: ?bool} */
    private function extractCheckbox(string $source): array
    {
        $checked = null;

        if (preg_match('/\{\{\s*\[\[DONE\]\]\s*\}\}/iu', $source)) {
            $checked = true;
        } elseif (preg_match('/\{\{\s*\[\[TODO\]\]\s*\}\}/iu', $source)) {
            $checked = false;
        }

        $source = preg_replace('/\{\{\s*\[\[(?:TODO|DONE)\]\]\s*\}\}\s*/iu', '', $source) ?? $source;

        return [$source, $checked];
    }

    /**
     * @return list<array{type: 'embed', offset: int, length: int, raw: string, uid: string}|array{type: 'attachment', offset: int, length: int, raw: string, url: string, label: string}>
     */
    private function blockTokens(string $source): array
    {
        $tokens = [];
        $embedPattern = '/\{\{\s*(?:\[\[)?embed(?:\]\])?\s*:\s*\(\(([^\)]+)\)\)\s*\}\}/iu';

        if (preg_match_all($embedPattern, $source, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
            foreach ($matches as $match) {
                $tokens[] = [
                    'type' => 'embed',
                    'offset' => $match[0][1],
                    'length' => strlen($match[0][0]),
                    'raw' => $match[0][0],
                    'uid' => $match[1][0],
                ];
            }
        }

        $imagePattern = '~!\[([^\]]*)\]\((https://firebasestorage\.googleapis\.com/[^\s)>}\]]+)\)~iu';

        if (preg_match_all($imagePattern, $source, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE)) {
            foreach ($matches as $match) {
                $tokens[] = [
                    'type' => 'attachment',
                    'offset' => $match[0][1],
                    'length' => strlen($match[0][0]),
                    'raw' => $match[0][0],
                    'url' => $match[2][0],
                    'label' => $match[1][0],
                ];
            }
        }

        if (preg_match_all('~https://firebasestorage\.googleapis\.com/[^\s)>}\]]+~iu', $source, $matches, PREG_OFFSET_CAPTURE)) {
            foreach ($matches[0] as $match) {
                $offset = $match[1];
                $length = strlen($match[0]);
                $overlaps = false;

                foreach ($tokens as $token) {
                    if ($offset < $token['offset'] + $token['length']
                        && $offset + $length > $token['offset']) {
                        $overlaps = true;

                        break;
                    }
                }

                if (! $overlaps) {
                    $tokens[] = [
                        'type' => 'attachment',
                        'offset' => $offset,
                        'length' => $length,
                        'raw' => $match[0],
                        'url' => $match[0],
                        'label' => '',
                    ];
                }
            }
        }

        usort($tokens, fn (array $left, array $right): int => $left['offset'] <=> $right['offset']);

        return $tokens;
    }

    /** @param list<array<string, mixed>> $blocks */
    private function appendParagraph(array &$blocks, string $text, ?int $heading): void
    {
        if ($text === '') {
            return;
        }

        $inline = $this->inlineContent($text);

        if ($inline !== [] || trim($text) !== '') {
            $blocks[] = $this->paragraph($inline, $heading);
        }
    }

    /** @return list<array<string, mixed>> */
    private function inlineContent(string $text): array
    {
        $nodes = [];
        $pattern = '~\[\[([^\]]+)\]\]|\(\(([^\)]+)\)\)|\[([^\]]+)\]\((https?://[^\s\)]+)\)|(https?://[^\s]+)~iu';
        $cursor = 0;

        if (! preg_match_all($pattern, $text, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE | PREG_UNMATCHED_AS_NULL)) {
            $this->appendText($nodes, $text);

            return $nodes;
        }

        foreach ($matches as $match) {
            $offset = $match[0][1];
            $this->appendText($nodes, substr($text, $cursor, $offset - $cursor));

            if (($match[1][1] ?? -1) >= 0) {
                $title = $match[1][0];
                $pageId = $this->pageIdsByTitle[$title]
                    ?? $this->caseInsensitivePageId($title);

                if ($pageId) {
                    $nodes[] = [
                        'type' => 'mention',
                        'attrs' => ['id' => $pageId, 'label' => $title],
                    ];
                } else {
                    $this->report->unresolvedPageReferences++;
                    $this->warnAboutPageReference($title);
                    $this->appendText($nodes, $match[0][0]);
                }
            } elseif (($match[2][1] ?? -1) >= 0) {
                $uid = $match[2][0];
                $targetId = $this->nodeIdsByUid[$uid] ?? null;

                if ($targetId) {
                    $nodes[] = [
                        'type' => 'blockReference',
                        'attrs' => [
                            'targetId' => $targetId,
                            'targetUid' => $uid,
                            'fallback' => $this->fallbackForUid($uid),
                        ],
                    ];
                } else {
                    $this->report->unresolvedBlockReferences++;
                    $this->warnAboutBlockReference($uid);
                    $this->appendText($nodes, $match[0][0]);
                }
            } elseif (($match[4][1] ?? -1) >= 0) {
                $nodes[] = [
                    'type' => 'webLink',
                    'attrs' => ['href' => $match[4][0], 'label' => $match[3][0]],
                ];
            } else {
                $nodes[] = [
                    'type' => 'webLink',
                    'attrs' => ['href' => $match[5][0], 'label' => null],
                ];
            }

            $cursor = $offset + strlen($match[0][0]);
        }

        $this->appendText($nodes, substr($text, $cursor));

        return $nodes;
    }

    /** @param list<array<string, mixed>> $nodes */
    private function appendText(array &$nodes, string $text): void
    {
        $parts = preg_split('/\R/u', $text);

        foreach ($parts ?: [] as $index => $part) {
            if ($index > 0) {
                $nodes[] = ['type' => 'hardBreak'];
            }

            if ($part !== '') {
                $nodes[] = ['type' => 'text', 'text' => $part];
            }
        }
    }

    /**
     * @param  list<array<string, mixed>>  $content
     * @return array<string, mixed>
     */
    private function paragraph(array $content, ?int $heading): array
    {
        $type = $heading && $heading >= 1 && $heading <= 3 ? 'heading' : 'paragraph';
        $node = ['type' => $type];

        if ($type === 'heading') {
            $node['attrs'] = ['level' => $heading];
        }

        if ($content !== []) {
            $node['content'] = $content;
        }

        return $node;
    }

    private function caseInsensitivePageId(string $title): ?string
    {
        $needle = mb_strtolower($title);

        foreach ($this->pageIdsByTitle as $candidate => $id) {
            if (mb_strtolower($candidate) === $needle) {
                return $id;
            }
        }

        return null;
    }

    private function fallbackForUid(string $uid): string
    {
        $content = $this->nodeContentByUid[$uid] ?? $uid;
        $content = preg_replace('/\{\{\s*\[\[(?:TODO|DONE)\]\]\s*\}\}\s*/iu', '', $content) ?? $content;

        return mb_strimwidth($content, 0, 180, '…');
    }

    private function nameFromUrl(string $url): string
    {
        $name = basename(rawurldecode((string) parse_url($url, PHP_URL_PATH)));

        return $name !== '' ? $name : 'Roam attachment';
    }

    private function warnAboutPageReference(string $title): void
    {
        if (isset($this->warnedPageReferences[$title])) {
            return;
        }

        $this->warnedPageReferences[$title] = true;
        $this->report->warnings[] = "Unresolved page reference [[{$title}]] was preserved as text.";
    }

    private function warnAboutBlockReference(string $uid): void
    {
        if (isset($this->warnedBlockReferences[$uid])) {
            return;
        }

        $this->warnedBlockReferences[$uid] = true;
        $this->report->warnings[] = "Unresolved block reference (({$uid})) was preserved as text.";
    }
}
