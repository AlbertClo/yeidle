import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/jetbrains-mono/wght-italic.css';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import { createInertiaApp } from '@inertiajs/vue3';
import { resolvePageComponent } from 'laravel-vite-plugin/inertia-helpers';
import type { DefineComponent } from 'vue';
import { createApp, h } from 'vue';
import '../css/app.css';
import { initializeTheme } from '@/composables/useAppearance';
import { initializeTypography } from '@/composables/useTypography';
import { eventMatchesCommand, loadKeyBindings } from '@/stores/keyBindings';
import { initializeRealtimeSync } from '@/sync/realtime';

const appName = import.meta.env.VITE_APP_NAME || 'Laravel';

function initializeNativeWindowFrame(): void {
    const windowControls = window.Native?.windowControls;

    if (!windowControls) {
        return;
    }

    const root = document.documentElement;
    const updateMaximizedState = (maximized: boolean) => {
        root.classList.toggle('native-window-maximized', maximized);
    };

    root.classList.add('native-window');
    updateMaximizedState(windowControls.isMaximized());

    const subscriptionId =
        windowControls.subscribeMaximizedChange(updateMaximizedState);

    window.addEventListener(
        'beforeunload',
        () => windowControls.unsubscribeMaximizedChange(subscriptionId),
        { once: true },
    );
}

initializeNativeWindowFrame();
initializeTypography();

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
void loadKeyBindings().catch(() => undefined);

function isTextEditingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return (
        target.matches('input, textarea, select') ||
        target.isContentEditable ||
        target.closest('[contenteditable="true"]') !== null
    );
}

document.addEventListener('keydown', (e) => {
    if (eventMatchesCommand(e, 'reload')) {
        e.preventDefault();

        if (window.Native?.windowControls) {
            window.Native.windowControls.reload();
        } else {
            window.location.reload();
        }

        return;
    }

    // Prevent Ctrl+Q from closing the app (Electron default)
    if ((e.ctrlKey || e.metaKey) && e.key === 'q') {
        e.preventDefault();
    }

    // Leave text-navigation keys alone while a user is editing content.
    if (!isTextEditingTarget(e.target) && eventMatchesCommand(e, 'back')) {
        e.preventDefault();
        window.history.back();
    }

    if (!isTextEditingTarget(e.target) && eventMatchesCommand(e, 'forward')) {
        e.preventDefault();
        window.history.forward();
    }
});
