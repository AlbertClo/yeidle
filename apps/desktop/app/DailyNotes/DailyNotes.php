<?php

namespace App\DailyNotes;

use Carbon\CarbonImmutable;
use Ramsey\Uuid\Uuid;

final class DailyNotes
{
    public const PAGE_TYPE = 'daily_note';

    private const UUID_NAMESPACE = '59563d4f-16f8-5ad7-a4ea-315cf0cae52d';

    public static function pageId(string $workspaceId, string $date): string
    {
        return Uuid::uuid5(
            self::UUID_NAMESPACE,
            "workspace:{$workspaceId}:daily-note:{$date}",
        )->toString();
    }

    public static function title(string $date): string
    {
        return CarbonImmutable::createFromFormat('!Y-m-d', $date)->format('F j, Y');
    }
}
