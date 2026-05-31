<?php

namespace App\Services;

use App\Models\Node;
use App\Models\NodeLink;

class LinkParser
{
    /**
     * Parse [[wikilinks]] from content and sync the node_links table.
     * Supports [[Page Title]] and [[Page Title|display name]].
     */
    public function syncLinks(Node $node): void
    {
        $parsed = $this->parse($node->content);

        $linkData = [];

        foreach ($parsed as $link) {
            $targetPage = Node::pages()->whereRaw('LOWER(content) = ?', [strtolower($link['target'])])->first();

            if (! $targetPage) {
                $targetPage = Node::create([
                    'content' => $link['target'],
                    'position' => 0,
                ]);
            }

            $linkData[$targetPage->id] = $link['display_name'];
        }

        // Delete existing links from this node
        $node->outgoingLinks()->delete();

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
