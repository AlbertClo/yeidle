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
import {
    initializeHistoryNavigation,
    navigateBack,
    navigateForward,
} from '@/navigation/historyNavigation';
import {
    navigationDirectionForKeyboardEvent,
    navigationDirectionForMouseButton,
} from '@/navigation/navigationInputs';
import type { NavigationDirection } from '@/navigation/navigationInputs';
import { eventMatchesCommand, loadKeyBindings } from '@/stores/keyBindings';
import { initializeRealtimeSync } from '@/sync/realtime';
import { hasOpenModal } from '@/ui/modal';

const appName = import.meta.env.VITE_APP_NAME || 'Laravel';
let lastNavigationCommand: {
    direction: NavigationDirection;
    receivedAt: number;
} | null = null;

function runNavigationCommand(direction: NavigationDirection): void {
    if (hasOpenModal()) {
        return;
    }

    const receivedAt = performance.now();

    // Some Electron/Linux combinations emit both a DOM mouse event and an
    // app-command for one side-button press. Treat those as one action.
    if (
        lastNavigationCommand?.direction === direction &&
        receivedAt - lastNavigationCommand.receivedAt < 250
    ) {
        return;
    }

    lastNavigationCommand = { direction, receivedAt };

    if (direction === 'back') {
        void navigateBack();
    } else {
        void navigateForward();
    }
}

function initializeMouseNavigation(): void {
    document.addEventListener(
        'mousedown',
        (event) => {
            const direction = navigationDirectionForMouseButton(event.button);

            if (!direction) {
                return;
            }

            event.preventDefault();
            runNavigationCommand(direction);
        },
        true,
    );
    document.addEventListener(
        'auxclick',
        (event) => {
            if (navigationDirectionForMouseButton(event.button)) {
                event.preventDefault();
            }
        },
        true,
    );
}

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
    const navigationSubscriptionId =
        windowControls.subscribeNavigationCommand(runNavigationCommand);

    window.addEventListener(
        'beforeunload',
        () => {
            windowControls.unsubscribeMaximizedChange(subscriptionId);
            windowControls.unsubscribeNavigationCommand(
                navigationSubscriptionId,
            );
        },
        { once: true },
    );
}

initializeNativeWindowFrame();
initializeMouseNavigation();
initializeTypography();
initializeHistoryNavigation();

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

document.addEventListener(
    'keydown',
    (e) => {
        const navigationDirection = navigationDirectionForKeyboardEvent(e);

        if (navigationDirection) {
            e.preventDefault();
            runNavigationCommand(navigationDirection);

            return;
        }

        if (eventMatchesCommand(e, 'reload')) {
            e.preventDefault();

            if (window.Native?.windowControls) {
                window.Native.windowControls.reload();
            } else {
                window.location.reload();
            }

            return;
        }

        if (eventMatchesCommand(e, 'back')) {
            e.preventDefault();
            void navigateBack();

            return;
        }

        if (eventMatchesCommand(e, 'forward')) {
            e.preventDefault();
            void navigateForward();
        }
    },
    true,
);

// Prevent Electron's Ctrl+Q default after editor and app commands have had a
// chance to handle the key. Preventing it during capture blocks ProseMirror.
document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'q') {
        event.preventDefault();
    }
});
