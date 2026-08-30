<?php

namespace App\Support;

final class SystemNodes
{
    public const PINS_ROOT_ID = '3a647fbb-04a3-512d-bc50-88214e6e14aa';

    public const PREFERENCES_ROOT_ID = 'a80584ce-bfc0-537d-b1fd-a76e68f1a949';

    public const COLLAPSED_NODES_ROOT_ID = 'cb358d9c-f818-406a-bce5-0e4c78b72b13';

    public const ROOT_IDS = [
        self::PINS_ROOT_ID,
        self::PREFERENCES_ROOT_ID,
        self::COLLAPSED_NODES_ROOT_ID,
    ];

    public static function isRoot(string $nodeId): bool
    {
        return in_array($nodeId, self::ROOT_IDS, true);
    }
}
