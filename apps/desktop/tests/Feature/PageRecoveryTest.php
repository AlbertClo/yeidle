<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class PageRecoveryTest extends TestCase
{
    use RefreshDatabase;

    public function test_missing_page_redirects_to_the_page_index_with_a_recovery_message(): void
    {
        $response = $this->get('/pages/00000000-0000-7000-8000-000000000404');

        $response
            ->assertRedirect(route('pages.index'))
            ->assertSessionHas('missing_page', true);

        $this->get(route('pages.index'))
            ->assertSuccessful()
            ->assertInertia(fn (Assert $page) => $page
                ->component('Pages/Index')
                ->where('missingPage', true));
    }
}
