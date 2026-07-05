<?php

namespace App\Sync;

use Closure;

/**
 * Hybrid Logical Clock. Produces lexicographically comparable timestamp
 * strings of the form {millis:15}-{counter:4 hex}-{client_id}, so ordering
 * ops is plain string comparison everywhere. One generator instance per
 * client_id — never share a client_id between two generators.
 */
final class HlcGenerator
{
    /** Sorts before every real HLC; the implicit clock of untouched fields. */
    public const EPOCH = '';

    private string $last = '';

    private Closure $millis;

    public function __construct(
        public readonly string $clientId,
        ?Closure $millis = null,
    ) {
        $this->millis = $millis ?? fn (): int => (int) (microtime(true) * 1000);
    }

    public function now(): string
    {
        $wall = ($this->millis)();

        if ($this->last === '') {
            return $this->last = self::encode($wall, 0, $this->clientId);
        }

        [$lastWall, $lastCount] = self::parse($this->last);

        // Never run backwards, even if the wall clock does
        if ($wall > $lastWall) {
            return $this->last = self::encode($wall, 0, $this->clientId);
        }

        if ($lastCount + 1 > 0xFFFF) {
            return $this->last = self::encode($lastWall + 1, 0, $this->clientId);
        }

        return $this->last = self::encode($lastWall, $lastCount + 1, $this->clientId);
    }

    /**
     * Ratchet forward on receipt of a remote HLC so that every subsequent
     * local timestamp orders after everything this client has observed.
     */
    public function observe(string $remote): void
    {
        if ($remote > $this->last) {
            [$ms, $count] = self::parse($remote);
            $this->last = self::encode($ms, $count, $this->clientId);
        }
    }

    public static function encode(int $millis, int $counter, string $clientId): string
    {
        return sprintf('%015d-%04x-%s', $millis, $counter, $clientId);
    }

    /** @return array{0: int, 1: int} [millis, counter] */
    public static function parse(string $hlc): array
    {
        return [(int) substr($hlc, 0, 15), (int) hexdec(substr($hlc, 16, 4))];
    }

    public static function millisOf(string $hlc): int
    {
        return (int) substr($hlc, 0, 15);
    }
}
