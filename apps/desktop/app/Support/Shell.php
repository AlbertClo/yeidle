<?php

namespace App\Support;

class Shell
{
    public static function open(string $path): void
    {
        $arg = escapeshellarg($path);
        match (PHP_OS_FAMILY) {
            'Darwin' => exec("open {$arg} > /dev/null 2>&1 &"), // untested
            'Windows' => exec("start \"\" {$arg}"), // untested
            default => exec("xdg-open {$arg} > /dev/null 2>&1 &"),
        };
    }
}
