<?php

namespace App\Events;

use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Contracts\Broadcasting\ShouldRescue;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

class DeviceAuthorizationApproved implements ShouldBroadcastNow, ShouldRescue
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly string $authorizationId) {}

    public function broadcastOn(): array
    {
        return [new PrivateChannel("device-authorizations.{$this->authorizationId}")];
    }

    public function broadcastAs(): string
    {
        return 'authorization.approved';
    }

    public function broadcastWith(): array
    {
        return ['authorization_id' => $this->authorizationId];
    }
}
