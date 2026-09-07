<?php

namespace App\Providers;

use Native\Desktop\Contracts\ProvidesPhpIni;
use Native\Desktop\Facades\Menu;
use Native\Desktop\Facades\Window;

class NativeAppServiceProvider implements ProvidesPhpIni
{
    /**
     * Executed once the native application has been booted.
     * Use this method to open windows, register global shortcuts, etc.
     */
    public function boot(): void
    {
        if (PHP_OS_FAMILY === 'Darwin') {
            Menu::create(Menu::app(), Menu::file(), Menu::edit(), Menu::window());
        } else {
            Menu::create();
        }

        Window::open()
            ->width(1280)
            ->height(800)
            ->frameless()
            ->transparent()
            ->hideMenu()
            ->maximized();
    }

    /**
     * Return an array of php.ini directives to be set.
     */
    public function phpIni(): array
    {
        return [
        ];
    }
}
