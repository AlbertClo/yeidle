<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DashboardTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_local_dashboard_is_available_without_web_authentication(): void
    {
        $this->get(route('dashboard'))->assertOk();
    }
}
