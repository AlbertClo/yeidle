<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class NavigationHistoryPageTest extends TestCase
{
    use RefreshDatabase;

    public function test_navigation_history_page_is_available(): void
    {
        $this->get('/navigation-history')
            ->assertSuccessful()
            ->assertInertia(fn (Assert $page) => $page
                ->component('NavigationHistory/Index'));
    }
}
