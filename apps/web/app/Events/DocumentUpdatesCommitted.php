<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Broadcasting\ShouldRescue;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * A hint that a workspace's document log grew. Clients pull the new updates;
 * the bytes themselves are never broadcast.
 */
class DocumentUpdatesCommitted implements ShouldBroadcast, ShouldDispatchAfterCommit, ShouldRescue
{
    use Dispatchable;

    public function __construct(
        public readonly string $workspaceId,
        public readonly string $originDeviceId,
        public readonly int $previousSeq,
        public readonly int $latestSeq,
    ) {}

    /**
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
        return 'updates.committed';
    }

    /**
     * @return array{workspace_id: string, origin_device_id: string, previous_seq: int, latest_seq: int}
     */
    public function broadcastWith(): array
    {
        return [
            'workspace_id' => $this->workspaceId,
            'origin_device_id' => $this->originDeviceId,
            'previous_seq' => $this->previousSeq,
            'latest_seq' => $this->latestSeq,
        ];
    }

    public function broadcastQueue(): string
    {
        return 'broadcasts';
    }
}
