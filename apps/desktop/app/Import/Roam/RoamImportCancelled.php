<?php

namespace App\Import\Roam;

use RuntimeException;

final class RoamImportCancelled extends RuntimeException
{
    public function __construct()
    {
        parent::__construct('The Roam import was stopped.');
    }
}
