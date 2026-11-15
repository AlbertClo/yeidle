<?php

/**
 * @param  array<string, string|null>  $variables
 * @return array{app_key: ?string, host: string, port: int, scheme: string}
 */
function reverbPublicConfig(array $variables): array
{
    $previous = [];

    foreach ($variables as $name => $value) {
        $previous[$name] = getenv($name);
        $value === null ? putenv($name) : putenv("{$name}={$value}");
        unset($_ENV[$name], $_SERVER[$name]);
    }

    try {
        return (require __DIR__.'/../../config/reverb.php')['public'];
    } finally {
        foreach ($previous as $name => $value) {
            $value === false ? putenv($name) : putenv("{$name}={$value}");
        }
    }
}

test('devices connect to the injected reverb address when no public one is set', function () {
    expect(reverbPublicConfig([
        'REVERB_PUBLIC_HOST' => null,
        'REVERB_PUBLIC_PORT' => null,
        'REVERB_PUBLIC_SCHEME' => null,
        'REVERB_HOST' => 'ws.example.com',
        'REVERB_PORT' => '443',
        'REVERB_SCHEME' => 'https',
    ]))->toMatchArray(['host' => 'ws.example.com', 'port' => 443, 'scheme' => 'https']);
});

test('a public reverb address overrides the internal one', function () {
    expect(reverbPublicConfig([
        'REVERB_PUBLIC_HOST' => 'localhost',
        'REVERB_PUBLIC_PORT' => '8080',
        'REVERB_PUBLIC_SCHEME' => 'http',
        'REVERB_HOST' => 'reverb',
        'REVERB_PORT' => '8080',
        'REVERB_SCHEME' => 'http',
    ]))->toMatchArray(['host' => 'localhost', 'port' => 8080, 'scheme' => 'http']);
});
