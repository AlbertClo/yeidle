<?php

namespace App\Sync;

use App\Models\Op;
use Illuminate\Support\Facades\DB;

/**
 * Ingest point for pushed ops: appends to the local log and applies to the
 * projection in one transaction. Idempotent — already-seen op_ids are
 * acknowledged without re-applying, so clients can retry a whole batch
 * after any failure.
 */
class SyncService
{
    public function __construct(
        private OpApplier $applier,
    ) {}

    /**
     * @param  array<int, array{op_id: string, client_id: string, hlc: string, type: string, payload: array}>  $ops
     * @return array<int, array{op_id: string, local_seq: int}>
     */
    public function push(array $ops): array
    {
        return DB::transaction(function () use ($ops) {
            $accepted = [];

            foreach ($ops as $op) {
                $existing = Op::where('op_id', $op['op_id'])->first();

                if ($existing) {
                    $accepted[] = ['op_id' => $op['op_id'], 'local_seq' => $existing->id];

                    continue;
                }

                $row = Op::create([
                    'op_id' => $op['op_id'],
                    'client_id' => $op['client_id'],
                    'hlc' => $op['hlc'],
                    'type' => $op['type'],
                    'payload' => $op['payload'],
                    'created_at' => now(),
                ]);

                $this->applier->apply($op);

                $accepted[] = ['op_id' => $op['op_id'], 'local_seq' => $row->id];
            }

            return $accepted;
        });
    }

    /**
     * Ops after the given local sequence number, in log order.
     *
     * @return array{ops: array, latest_seq: int}
     */
    public function pull(int $since): array
    {
        $ops = Op::where('id', '>', $since)
            ->orderBy('id')
            ->get()
            ->map(fn (Op $op) => [
                'local_seq' => $op->id,
                'op_id' => $op->op_id,
                'client_id' => $op->client_id,
                'hlc' => $op->hlc,
                'type' => $op->type,
                'payload' => $op->payload,
            ])
            ->all();

        return [
            'ops' => $ops,
            'latest_seq' => $ops === [] ? $since : end($ops)['local_seq'],
        ];
    }
}
