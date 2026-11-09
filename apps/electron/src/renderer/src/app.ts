import '@fontsource-variable/atkinson-hyperlegible-next';
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/jetbrains-mono/wght-italic.css';
import '@fontsource-variable/source-serif-4';
import '@fontsource-variable/source-serif-4/wght-italic.css';
import { createInertiaApp } from '@inertiajs/vue3';
import axios from 'axios';
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
import {
    eventMatchesCommand,
    loadKeyBindings,
    prepareShortcutEvent,
    resetKeySequence,
} from '@/stores/keyBindings';
import { documentChangesAsOps, notifyLocalOpsAvailable } from '@/sync/localOps';
import { initializeRealtimeSync } from '@/sync/realtime';
import { keyboardPlatform } from '@/types/keyboardPlatform';
import { hasOpenModal } from '@/ui/modal';

const appName = 'Yeidle';

// Pages are served from yeidle://, which axios's XHR adapter refuses; its
// fetch adapter has no scheme allow-list
axios.defaults.adapter = 'fetch';
const pages = import.meta.glob<DefineComponent>('./pages/**/*.vue');
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

// The app process announces every committed document change to all windows
window.Native?.subscribeDocumentChanges?.((documentIds) =>
    notifyLocalOpsAvailable(documentChangesAsOps(documentIds)),
);
initializeTypography();
initializeHistoryNavigation();

createInertiaApp({
    title: (title) => (title ? `${title} - ${appName}` : appName),
    resolve: async (name) => {
        const page = pages[`./pages/${name}.vue`];

        if (!page) {
            throw new Error(`Page not found: ./pages/${name}.vue`);
        }

        return page();
    },
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
        if (prepareShortcutEvent(e)) {
            e.preventDefault();
            e.stopPropagation();

            return;
        }

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

document.addEventListener('pointerdown', resetKeySequence, true);
window.addEventListener('blur', resetKeySequence);

// Keep Ctrl+Q assignable on Windows/Linux after editor commands can handle it.
// On Mac, leave Cmd+Q to the native Quit action.
document.addEventListener('keydown', (event) => {
    if (
        keyboardPlatform() !== 'mac' &&
        event.ctrlKey &&
        event.key.toLowerCase() === 'q'
    ) {
        event.preventDefault();
    }
});
