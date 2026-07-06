<?php

namespace App\Sync;

use App\Models\Media;
use App\Models\Node;
use App\Models\Op;
use App\Models\User;
use App\Models\Workspace;
use Illuminate\Support\Facades\DB;

/**
 * The cloud relay (sync design §6, §8): appends pushed ops to a workspace's
 * log with a server-assigned sequence and applies them to the projections
 * in one transaction. Idempotent by op_id so clients retry whole batches
 * safely. user_id is stamped from the authenticated user, never trusted
 * from the payload.
 */
class SyncService
{
    /**
     * @param  array<int, array{op_id: string, client_id: string, hlc: string, type: string, payload: array}>  $ops
     * @return array<int, array{op_id: string, server_seq: int}>
     */
    public function push(Workspace $workspace, User $user, array $ops): array
    {
        return DB::transaction(function () use ($workspace, $user, $ops) {
            $applier = new OpApplier($workspace->id);
            $accepted = [];

            foreach ($ops as $op) {
                $existing = Op::where('op_id', $op['op_id'])->first();

                if ($existing) {
                    // Ack replays of this workspace's own ops; an op_id
                    // claimed by another workspace is silently skipped
                    if ($existing->workspace_id === $workspace->id) {
                        $accepted[] = ['op_id' => $op['op_id'], 'server_seq' => $existing->server_seq];
                    }

                    continue;
                }

                $row = Op::create([
                    'workspace_id' => $workspace->id,
                    'op_id' => $op['op_id'],
                    'client_id' => $op['client_id'],
                    'user_id' => $user->id,
                    'hlc' => $op['hlc'],
                    'type' => $op['type'],
                    'payload' => $op['payload'],
                    'created_at' => now(),
                ]);

                $applier->apply($op);

                $accepted[] = ['op_id' => $op['op_id'], 'server_seq' => $row->server_seq];
            }

            return $accepted;
        });
    }

    /**
     * @return array{ops: array, latest_seq: int}
     */
    public function pull(Workspace $workspace, int $since, int $limit = 1000): array
    {
        $ops = Op::where('workspace_id', $workspace->id)
            ->where('server_seq', '>', $since)
            ->orderBy('server_seq')
            ->limit($limit)
            ->get()
            ->map(fn (Op $op) => [
                'server_seq' => $op->server_seq,
                'op_id' => $op->op_id,
                'client_id' => $op->client_id,
                'hlc' => $op->hlc,
                'type' => $op->type,
                'payload' => $op->payload,
            ])
            ->all();

        return [
            'ops' => $ops,
            'latest_seq' => max($since, (int) Op::where('workspace_id', $workspace->id)->max('server_seq')),
        ];
    }

    /**
     * Full projection snapshot for a fresh device (sync design §6). The
     * cursor is read BEFORE the projections so an op landing in between is
     * re-pulled (idempotent) rather than missed.
     *
     * @return array{latest_seq: int, nodes: array, media: array}
     */
    public function bootstrap(Workspace $workspace): array
    {
        $latestSeq = (int) Op::where('workspace_id', $workspace->id)->max('server_seq');

        $nodes = Node::withTrashed()
            ->where('workspace_id', $workspace->id)
            ->get()
            ->map(fn (Node $node) => array_merge(
                $node->makeVisible(['field_clocks', 'purged'])->toArray(),
                ['deleted_at' => $node->deleted_at?->toIso8601String()],
            ))
            ->all();

        $media = Media::where('workspace_id', $workspace->id)->get()->toArray();

        return [
            'latest_seq' => $latestSeq,
            'nodes' => $nodes,
            'media' => $media,
        ];
    }
}
