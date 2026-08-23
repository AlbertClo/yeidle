import { createInertiaApp } from '@inertiajs/vue3';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';
import type { DefineComponent } from 'vue';
import { createApp, h } from 'vue';
import '../css/app.css';
import { initializeTheme } from '@/composables/useAppearance';
import { initializeRealtimeSync } from '@/sync/realtime';

const appName = import.meta.env.VITE_APP_NAME || 'Laravel';

createInertiaApp({
    title: (title) => (title ? `${title} - ${appName}` : appName),
    resolve: (name) =>
        resolvePageComponent(
            `./pages/${name}.vue`,
            import.meta.glob<DefineComponent>('./pages/**/*.vue'),
        ),
    setup({ el, App, props, plugin }) {
        createApp({ render: () => h(App, props) })
            .use(plugin)
            .mount(el);
    },
    progress: {
        color: '#4B5563',
    },
});

// This will set light / dark mode on page load...
initializeTheme();
initializeRealtimeSync();

document.addEventListener('keydown', (e) => {
    // Prevent Ctrl+Q from closing the app (Electron default)
    if ((e.ctrlKey || e.metaKey) && e.key === 'q') {
        e.preventDefault();
    }

    // Alt+Left/Right for browser history navigation
    if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        window.history.back();
    }

    if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        window.history.forward();
    }
});
