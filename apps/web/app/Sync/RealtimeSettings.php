<?php

namespace App\Sync;

final class RealtimeSettings
{
    /**
     * Public Reverb connection settings only. The app secret stays server-side.
     *
     * @return array{enabled: bool, app_key: ?string, host: ?string, port: ?int, scheme: ?string}
     */
    public static function public(): array
    {
        $key = config('reverb.public.app_key');
        $host = config('reverb.public.host');
        $port = config('reverb.public.port');
        $scheme = config('reverb.public.scheme');
        $enabled = config('broadcasting.default') === 'reverb'
            && is_string($key) && $key !== ''
            && is_string($host) && $host !== ''
            && is_numeric($port)
            && in_array($scheme, ['http', 'https'], true);

        return [
            'enabled' => $enabled,
            'app_key' => $enabled ? $key : null,
            'host' => $enabled ? $host : null,
            'port' => $enabled ? (int) $port : null,
            'scheme' => $enabled ? $scheme : null,
        ];
    }
}
