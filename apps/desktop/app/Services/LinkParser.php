<?php

namespace App\Services;

/**
 * Extracts native page and block links from TipTap JSON. Used by the op-apply
 * function to rebuild the node_links projection — links derive from
 * UUID-based mentions only (sync design §5): title-based resolution against
 * local state would mint different page ids on different replicas.
 */
class LinkParser
{
    /**
     * Extract linked nodes from tiptap_content JSON.
     * Returns array of ['id' => pageId, 'label' => label]
     */
    public function extractMentions(array $content): array
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

        if (in_array(($content['type'] ?? ''), ['blockReference', 'blockEmbed'], true)
            && isset($content['attrs']['targetId'])) {
            $mentions[] = [
                'id' => $content['attrs']['targetId'],
                'label' => $content['attrs']['fallback'] ?? null,
            ];
        }

        foreach ($content['content'] ?? [] as $child) {
            if (is_array($child)) {
                $mentions = array_merge($mentions, $this->extractMentions($child));
            }
        }

        return $mentions;
    }
}
