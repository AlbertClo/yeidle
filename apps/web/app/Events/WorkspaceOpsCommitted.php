<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Broadcasting\ShouldRescue;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * @phpstan-type CommittedOp array{
 *     server_seq: int,
 *     op_id: string,
 *     client_id: string,
 *     hlc: string,
 *     type: string,
 *     payload: array<string, mixed>
 * }
 */
class WorkspaceOpsCommitted implements ShouldBroadcast, ShouldDispatchAfterCommit, ShouldRescue
{
    use Dispatchable, SerializesModels;

    /**
     * @param  array<int, CommittedOp>|null  $ops
     */
    public function __construct(
        public readonly string $workspaceId,
        public readonly string $originClientId,
        public readonly int $previousSeq,
        public readonly int $latestSeq,
        public readonly ?array $ops,
    ) {}

    /**
     * Get the channels the event should broadcast on.
     *
     * @return array<int, Channel>
     */
    public function broadcastOn(): array
    {
        return [
            new PrivateChannel("workspaces.{$this->workspaceId}.sync"),
        ];
    }

    public function broadcastAs(): string
    {
        return 'ops.committed';
    }

    /**
     * @return array{
     *     workspace_id: string,
     *     origin_client_id: string,
     *     previous_seq: int,
     *     latest_seq: int,
     *     ops: array<int, CommittedOp>|null
     * }
     */
    public function broadcastWith(): array
    {
        return [
            'workspace_id' => $this->workspaceId,
            'origin_client_id' => $this->originClientId,
            'previous_seq' => $this->previousSeq,
            'latest_seq' => $this->latestSeq,
            'ops' => $this->ops,
        ];
    }

    public function broadcastQueue(): string
    {
        return 'broadcasts';
    }
}
