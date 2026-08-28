<!DOCTYPE html>
<html
    lang="{{ str_replace('_', '-', app()->getLocale()) }}"
    data-theme="{{ $appearance ?? \App\Support\PreferenceNodes::DEFAULT_THEME }}"
    @class(['dark' => in_array(($appearance ?? \App\Support\PreferenceNodes::DEFAULT_THEME), \App\Support\PreferenceNodes::DARK_THEMES, true)])
>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">

        {{-- Inline script to detect system dark mode preference and apply it immediately --}}
        <script>
            (function() {
                const appearance = @json($appearance ?? \App\Support\PreferenceNodes::DEFAULT_THEME);

                if (appearance === 'system') {
                    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

                    document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
                    document.documentElement.classList.toggle('dark', prefersDark);
                }
            })();
        </script>

        {{-- Inline style to set the HTML background color based on our theme in app.css --}}
        <style>
            html {
                background-color: oklch(1 0 0);
            }

            html.dark {
                background-color: oklch(0.145 0 0);
            }

            html[data-theme='catppuccin-mocha'] { background-color: #1e1e2e; }
            html[data-theme='catppuccin-latte'] { background-color: #eff1f5; }
            html[data-theme='blush'] { background-color: #fff7fb; }
            html[data-theme='gruvbox-dark'] { background-color: #282828; }
            html[data-theme='gruvbox-light'] { background-color: #fbf1c7; }
            html[data-theme='tokyo-night'] { background-color: #1a1b26; }
            html[data-theme='cyberpunk'] { background-color: #160b2d; }
            html[data-theme='nord'] { background-color: #2e3440; }
            html[data-theme='solarized-dark'] { background-color: #002b36; }
            html[data-theme='solarized-light'] { background-color: #fdf6e3; }
            html[data-theme='cobalt2'] { background-color: #193549; }
            html[data-theme='monokai'] { background-color: #272822; }
            html[data-theme='paper'] { background-color: #f7f3ea; }
        </style>

        <title inertia>{{ config('app.name', 'Laravel') }}</title>

        <link rel="icon" href="/favicon.ico" sizes="any">
        <link rel="icon" href="/favicon.svg" type="image/svg+xml">
        <link rel="apple-touch-icon" href="/apple-touch-icon.png">

        <link rel="preconnect" href="https://fonts.bunny.net">
        <link href="https://fonts.bunny.net/css?family=instrument-sans:400,500,600" rel="stylesheet" />

        @vite(['resources/js/app.ts', "resources/js/pages/{$page['component']}.vue"])
        @inertiaHead
    </head>
    <body class="font-sans antialiased">
        @inertia
    </body>
</html>
