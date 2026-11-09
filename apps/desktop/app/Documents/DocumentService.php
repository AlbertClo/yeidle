<?php

namespace App\Documents;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * The single write path for workspace content. Every change is a Loro update
 * to a document: edits arrive as updates from the editor, and PHP-originated
 * changes are turned into updates by the worker. Each write appends to the
 * update log, refreshes the document snapshot and re-projects the document
 * into the read model, all in one transaction.
 */
class DocumentService
{
    public const MEDIA_DOCUMENT_ID = 'media';

    public function __construct(
        private DocumentStore $store,
        private LoroWorker $worker,
        private Projector $projector,
    ) {}

    /**
     * Stores updates produced elsewhere (an editor window or the cloud) and
     * re-projects the document. Already-stored update ids are ignored.
     *
     * @param  list<array{update_id?: string, client_id: string, bytes: string, cloud_seq?: ?int}>  $updates
     * @return int the document's latest local sequence
     */
    public function applyUpdates(string $documentId, array $updates): int
    {
        return DB::transaction(function () use ($documentId, $updates) {
            $this->store->lock($documentId);
            $new = false;

            foreach ($updates as $update) {
                $result = $this->store->append(
                    $documentId,
                    $update['bytes'],
                    $update['client_id'],
                    $update['update_id'] ?? null,
                    $update['cloud_seq'] ?? null,
                );
                $new = $result['new'] || $new;
            }

            if ($new) {
                $this->refresh([$documentId]);
            }

            return $this->store->latestSeq($documentId);
        });
    }

    /**
     * Applies changes that originate in PHP. Each action targets one document
     * and carries node changes (`node.set`/`node.delete` in the editor's
     * shape), a full page replacement, or media metadata.
     *
     * @param  list<array{document_id: string, changes?: list<array>, replace?: array, media?: list<array>}>  $actions
     * @return list<string> ids of the documents that changed
     */
    public function apply(array $actions, string $message = '', string $clientId = 'server'): array
    {
        if ($actions === []) {
            return [];
        }

        return DB::transaction(function () use ($actions, $message, $clientId) {
            $documentIds = array_values(array_unique(array_column($actions, 'document_id')));
            sort($documentIds);

            foreach ($documentIds as $documentId) {
                $this->store->lock($documentId);
            }

            $results = $this->worker->run([
                'documents' => array_map(
                    fn (string $id) => array_diff_key($this->store->load($id), ['seq' => true]),
                    $documentIds,
                ),
                'actions' => $actions,
                'message' => $message,
            ]);

            $changed = [];

            foreach ($results as $result) {
                if ($result['update'] !== null) {
                    $seq = $this->store->append($result['id'], $result['update'], $clientId.'-'.Str::uuid7())['seq'];

                    if ($result['snapshot'] !== null) {
                        $this->store->saveSnapshot($result['id'], $result['snapshot'], $seq);
                    }

                    $changed[] = $result['id'];
                }

                // Projected even when unchanged: the write is a no-op unless
                // the read model has drifted from the document
                $this->projector->write($result['id'], $result['rows']);
            }

            return $changed;
        });
    }

    /**
     * Applies node changes in the op shape the app's PHP producers build
     * (`type` + `payload` with `id`, `page_id` and `fields`). Changes are
     * grouped into one action per document; media.create goes to the media
     * document.
     *
     * @param  list<array{type: string, payload: array}>  $changes
     * @return list<string>
     */
    public function applyNodeChanges(array $changes, string $message = '', string $clientId = 'server'): array
    {
        $actions = [];
        $roots = $this->rootResolver($changes);

        foreach ($changes as $change) {
            $payload = $change['payload'] ?? [];

            if (($change['type'] ?? null) === 'media.create') {
                $actions[self::MEDIA_DOCUMENT_ID] ??= ['document_id' => self::MEDIA_DOCUMENT_ID, 'media' => []];
                $actions[self::MEDIA_DOCUMENT_ID]['media'][] = [
                    'id' => $payload['id'],
                    'hash' => $payload['hash'],
                    'original_name' => $payload['original_name'],
                    'mime_type' => $payload['mime_type'],
                    'size' => (int) $payload['size'],
                    'created_at' => $payload['created_at'] ?? now()->toIso8601String(),
                ];

                continue;
            }

            if (! is_string($payload['id'] ?? null)) {
                continue;
            }

            $documentId = $roots($payload['id'], $payload['page_id'] ?? null);

            $actions[$documentId] ??= ['document_id' => $documentId, 'changes' => []];
            $actions[$documentId]['changes'][] = [
                'type' => $change['type'],
                'payload' => [
                    'id' => $payload['id'],
                    'page_id' => $documentId,
                    'fields' => $payload['fields'] ?? [],
                ],
            ];
        }

        return $this->apply(array_values($actions), $message, $clientId);
    }

    /**
     * Finds the top-level node (and so the document) each changed node lives
     * under. A producer's page_id is only a hint — it may name an
     * intermediate ancestor — so parents are followed through the batch and
     * then the read model.
     *
     * @param  list<array{type: string, payload: array}>  $changes
     * @return \Closure(string, ?string): string
     */
    private function rootResolver(array $changes): \Closure
    {
        $batchParents = [];

        foreach ($changes as $change) {
            $fields = $change['payload']['fields'] ?? [];

            if (($change['type'] ?? null) === 'node.set' && array_key_exists('parent_id', $fields)) {
                $batchParents[$change['payload']['id']] = $fields['parent_id'];
            }
        }

        $cache = [];

        $resolve = function (string $id, ?string $hint) use (&$resolve, &$cache, $batchParents): string {
            if (isset($cache[$id])) {
                return $cache[$id];
            }

            $seen = [];
            $current = $id;

            while (! isset($seen[$current])) {
                $seen[$current] = true;

                if (array_key_exists($current, $batchParents)) {
                    $parent = $batchParents[$current];
                } else {
                    $row = DB::table('nodes')->where('id', $current)->first(['parent_id', 'document_id']);

                    if ($row === null) {
                        return $cache[$id] = $current === $id ? ($hint ?? $id) : $current;
                    }

                    if ($row->document_id !== null) {
                        return $cache[$id] = $row->document_id;
                    }

                    $parent = $row->parent_id;
                }

                if (! is_string($parent)) {
                    return $cache[$id] = $current;
                }

                $current = $parent;
            }

            return $cache[$id] = $hint ?? $id;
        };

        return $resolve;
    }

    /**
     * Re-projects documents from their stored state, compacting their
     * snapshots. Used after updates arrive from the cloud.
     *
     * @param  list<string>  $documentIds
     */
    public function refresh(array $documentIds): void
    {
        foreach (array_chunk($documentIds, 200) as $chunk) {
            $loaded = array_map(fn (string $id) => $this->store->load($id), $chunk);
            $seqs = array_column($loaded, 'seq', 'id');
            $results = $this->worker->run([
                'documents' => array_map(fn (array $doc) => array_diff_key($doc, ['seq' => true]), $loaded),
            ]);

            foreach ($results as $result) {
                if ($result['snapshot'] !== null) {
                    $this->store->saveSnapshot($result['id'], $result['snapshot'], $seqs[$result['id']]);
                }

                $this->projector->write($result['id'], $result['rows']);
            }
        }
    }
}
