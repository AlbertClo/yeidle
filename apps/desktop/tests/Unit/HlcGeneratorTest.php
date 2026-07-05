<?php

namespace Tests\Unit;

use App\Sync\HlcGenerator;
use PHPUnit\Framework\TestCase;

class HlcGeneratorTest extends TestCase
{
    public function test_matches_shared_encoding_vectors(): void
    {
        $vectors = json_decode(file_get_contents(__DIR__.'/../Fixtures/hlc-vectors.json'), true);

        foreach ($vectors['encode'] as $v) {
            $this->assertSame(
                $v['expected'],
                HlcGenerator::encode($v['millis'], $v['counter'], $v['clientId']),
            );
        }

        foreach ($vectors['ordering'] as [$lesser, $greater]) {
            $this->assertTrue($lesser < $greater, "expected {$lesser} < {$greater}");
        }
    }

    public function test_is_monotonic_when_wall_clock_stalls(): void
    {
        $gen = new HlcGenerator('c1', fn (): int => 1000);

        $a = $gen->now();
        $b = $gen->now();
        $c = $gen->now();

        $this->assertTrue($a < $b && $b < $c);
        $this->assertSame(1000, HlcGenerator::millisOf($c));
    }

    public function test_is_monotonic_when_wall_clock_regresses(): void
    {
        $times = [5000, 3000, 3000];
        $gen = new HlcGenerator('c1', function () use (&$times): int {
            return array_shift($times);
        });

        $a = $gen->now();
        $b = $gen->now();
        $c = $gen->now();

        $this->assertTrue($a < $b && $b < $c);
        $this->assertSame(5000, HlcGenerator::millisOf($c));
    }

    public function test_observe_ratchets_past_remote_clocks(): void
    {
        $gen = new HlcGenerator('aa', fn (): int => 1000);

        $remote = HlcGenerator::encode(9000, 7, 'zz');
        $gen->observe($remote);

        $next = $gen->now();
        $this->assertTrue($next > $remote, "expected {$next} > {$remote}");
    }

    public function test_counter_overflow_rolls_into_millis(): void
    {
        $gen = new HlcGenerator('c1', fn (): int => 1000);
        $gen->observe(HlcGenerator::encode(1000, 0xFFFF, 'c1'));

        $next = $gen->now();
        $this->assertSame(1001, HlcGenerator::millisOf($next));
    }

    public function test_parse_round_trips(): void
    {
        $hlc = HlcGenerator::encode(1751793445123, 66, 'client-x');
        $this->assertSame([1751793445123, 66], HlcGenerator::parse($hlc));
    }
}
