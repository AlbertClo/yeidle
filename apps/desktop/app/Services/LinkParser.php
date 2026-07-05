<?php

namespace App\Services;

use App\Models\Node;
use App\Models\NodeLink;

class LinkParser
{
    /**
     * Sync node_links by extracting mentions from tiptap_content,
     * falling back to parsing [[wikilinks]] from plain text content.
     */
    public function syncLinks(Node $node): void
    {
        $linkData = [];

        // Primary: extract mentions from tiptap_content (has page UUID directly)
        if ($node->tiptap_content) {
            $mentions = $this->extractMentions($node->tiptap_content);
            foreach ($mentions as $mention) {
                $targetId = $mention['id'];
                // Verify the target page exists
                if (Node::where('id', $targetId)->exists()) {
                    $linkData[$targetId] = $mention['label'];
                }
            }
        }

        // Fallback: parse [[wikilinks]] from plain text content
        if (empty($linkData)) {
            $parsed = $this->parse($node->content);
            foreach ($parsed as $link) {
                $targetPage = Node::pages()
                    ->whereRaw('LOWER(content) = ?', [strtolower($link['target'])])
                    ->first();

                if (! $targetPage) {
                    $targetPage = Node::create([
                        'content' => $link['target'],
                        'position' => 'a0',
                    ]);
                }

                $linkData[$targetPage->id] = $link['display_name'];
            }
        }

        // Hard delete existing links
        $node->outgoingLinks()->forceDelete();

        // Create new links
        foreach ($linkData as $targetId => $displayName) {
            NodeLink::create([
                'source_node_id' => $node->id,
                'target_node_id' => $targetId,
                'display_name' => $displayName,
            ]);
        }
    }

    /**
     * Extract mention nodes from tiptap_content JSON.
     * Returns array of ['id' => pageId, 'label' => label]
     */
    private function extractMentions(array $content): array
    {
        // tiptap_content can be a sequential array (multiple blocks) or a single object
        if (array_is_list($content)) {
            $mentions = [];
            foreach ($content as $item) {
                if (is_array($item)) {
                    $mentions = array_merge($mentions, $this->extractMentions($item));
                }
            }

            return $mentions;
        }

        $mentions = [];

        if (($content['type'] ?? '') === 'mention' && isset($content['attrs']['id'])) {
            $mentions[] = [
                'id' => $content['attrs']['id'],
                'label' => $content['attrs']['label'] ?? null,
            ];
        }

        foreach ($content['content'] ?? [] as $child) {
            if (is_array($child)) {
                $mentions = array_merge($mentions, $this->extractMentions($child));
            }
        }

        return $mentions;
    }

    /**
     * Parse content for [[wikilinks]], returning an array of
     * ['target' => 'Page Title', 'display_name' => 'custom text' or null]
     */
    public function parse(string $content): array
    {
        $links = [];

        preg_match_all('/\[\[([^\]]+)\]\]/', $content, $matches);

        foreach ($matches[1] as $match) {
            if (str_contains($match, '|')) {
                [$target, $displayName] = explode('|', $match, 2);
                $links[] = [
                    'target' => trim($target),
                    'display_name' => trim($displayName),
                ];
            } else {
                $links[] = [
                    'target' => trim($match),
                    'display_name' => null,
                ];
            }
        }

        return $links;
    }
}
