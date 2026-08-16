<?php

namespace App\Sync;

use App\Events\WorkspaceOpsCommitted;
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
 *
 * @phpstan-type IncomingOp array{
 *     op_id: string,
 *     client_id: string,
 *     hlc: string,
 *     type: string,
 *     payload: array<string, mixed>
 * }
 * @phpstan-type CommittedOp array{
 *     server_seq: int,
 *     op_id: string,
 *     client_id: string,
 *     hlc: string,
 *     type: string,
 *     payload: array<string, mixed>
 * }
 */
class SyncService
{
    /**
     * @param  array<int, IncomingOp>  $ops
     * @return array<int, array{op_id: string, server_seq: int}>
     */
    public function push(Workspace $workspace, User $user, string $originClientId, array $ops): array
    {
        return DB::transaction(function () use ($workspace, $user, $originClientId, $ops) {
            Workspace::whereKey($workspace->id)->lockForUpdate()->firstOrFail();

            $previousSeq = (int) Op::where('workspace_id', $workspace->id)->max('server_seq');
            $applier = new OpApplier($workspace->id);
            $accepted = [];
            $committed = [];

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
                $committed[] = $this->serializeOp($row);
            }

            if ($committed !== []) {
                $latestSeq = $committed[array_key_last($committed)]['server_seq'];

                WorkspaceOpsCommitted::dispatch(
                    $workspace->id,
                    $originClientId,
                    $previousSeq,
                    $latestSeq,
                    $this->broadcastPayloadOps(
                        $workspace->id,
                        $originClientId,
                        $previousSeq,
                        $latestSeq,
                        $committed,
                    ),
                );
            }

            return $accepted;
        });
    }

    /**
     * @return array{ops: array<int, CommittedOp>, latest_seq: int}
     */
    public function pull(Workspace $workspace, int $since, int $limit = 1000): array
    {
        $ops = Op::where('workspace_id', $workspace->id)
            ->where('server_seq', '>', $since)
            ->orderBy('server_seq')
            ->limit($limit)
            ->get()
            ->map(fn (Op $op) => $this->serializeOp($op))
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
     * @return array{
     *     latest_seq: int,
     *     nodes: array<int, array<string, mixed>>,
     *     media: array<int, array<string, mixed>>
     * }
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

    /**
     * @return CommittedOp
     */
    private function serializeOp(Op $op): array
    {
        return [
            'server_seq' => $op->server_seq,
            'op_id' => $op->op_id,
            'client_id' => $op->client_id,
            'hlc' => $op->hlc,
            'type' => $op->type,
            'payload' => $op->payload,
        ];
    }

    /**
     * Large batches fall back to the durable pull path instead of exceeding
     * Reverb's configured message limit.
     *
     * @param  array<int, CommittedOp>  $ops
     * @return array<int, CommittedOp>|null
     */
    private function broadcastPayloadOps(
        string $workspaceId,
        string $originClientId,
        int $previousSeq,
        int $latestSeq,
        array $ops,
    ): ?array {
        $encoded = json_encode([
            'workspace_id' => $workspaceId,
            'origin_client_id' => $originClientId,
            'previous_seq' => $previousSeq,
            'latest_seq' => $latestSeq,
            'ops' => $ops,
        ]);

        $maximumBytes = (int) config('reverb.broadcast_max_payload_size', 8_000);

        if (! is_string($encoded) || strlen($encoded) > $maximumBytes) {
            return null;
        }

        return $ops;
    }
}
