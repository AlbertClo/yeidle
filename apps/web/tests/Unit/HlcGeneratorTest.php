<?php

use App\Sync\HlcGenerator;

test('matches shared encoding vectors', function () {
    $vectors = json_decode(file_get_contents(__DIR__.'/../Fixtures/hlc-vectors.json'), true);

    foreach ($vectors['encode'] as $v) {
        expect(HlcGenerator::encode($v['millis'], $v['counter'], $v['clientId']))
            ->toBe($v['expected']);
    }

    foreach ($vectors['ordering'] as [$lesser, $greater]) {
        expect($lesser < $greater)->toBeTrue("expected {$lesser} < {$greater}");
    }
});

test('is monotonic when the wall clock stalls', function () {
    $gen = new HlcGenerator('c1', fn (): int => 1000);

    $a = $gen->now();
    $b = $gen->now();
    $c = $gen->now();

    expect($a < $b && $b < $c)->toBeTrue();
    expect(HlcGenerator::millisOf($c))->toBe(1000);
});

test('is monotonic when the wall clock regresses', function () {
    $times = [5000, 3000, 3000];
    $gen = new HlcGenerator('c1', function () use (&$times): int {
        return array_shift($times);
    });

    $a = $gen->now();
    $b = $gen->now();
    $c = $gen->now();

    expect($a < $b && $b < $c)->toBeTrue();
    expect(HlcGenerator::millisOf($c))->toBe(5000);
});

test('observe ratchets past remote clocks', function () {
    $gen = new HlcGenerator('aa', fn (): int => 1000);
    $remote = HlcGenerator::encode(9000, 7, 'zz');
    $gen->observe($remote);

    expect($gen->now() > $remote)->toBeTrue();
});
