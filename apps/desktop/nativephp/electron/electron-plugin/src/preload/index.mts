import remote from '@electron/remote';
import { contextBridge, ipcRenderer } from 'electron';

let nextWindowControlSubscriptionId = 1;
const windowControlSubscriptions = new Map<
    number,
    {
        window: Electron.BrowserWindow;
        listener: () => void;
    }
>();

// -------------------------------------------------------------------
// The Native helper
// -------------------------------------------------------------------
const Native = {
    on: (event, callback) => {
        ipcRenderer.on('native-event', (_, data) => {
            // Strip leading slashes
            event = event.replace(/^(\\)+/, '');
            data.event = data.event.replace(/^(\\)+/, '');

            if (event === data.event) {
                return callback(data.payload, event);
            }
        });
    },
    contextMenu: (template) => {
        const menu = remote.Menu.buildFromTemplate(template);
        menu.popup({ window: remote.getCurrentWindow() });
    },
    windowControls: {
        minimize: () => remote.getCurrentWindow().minimize(),
        reload: () => remote.getCurrentWindow().reload(),
        toggleMaximize: () => {
            const currentWindow = remote.getCurrentWindow();

            if (currentWindow.isMaximized()) {
                currentWindow.unmaximize();
            } else {
                currentWindow.maximize();
            }

            return currentWindow.isMaximized();
        },
        close: () => remote.getCurrentWindow().close(),
        isMaximized: () => remote.getCurrentWindow().isMaximized(),
        subscribeMaximizedChange: (callback: (maximized: boolean) => void) => {
            const id = nextWindowControlSubscriptionId++;
            const currentWindow = remote.getCurrentWindow();
            const listener = () => callback(currentWindow.isMaximized());

            currentWindow.on('maximize', listener);
            currentWindow.on('unmaximize', listener);
            windowControlSubscriptions.set(id, {
                window: currentWindow,
                listener,
            });

            return id;
        },
        unsubscribeMaximizedChange: (id: number) => {
            const subscription = windowControlSubscriptions.get(id);

            if (!subscription) {
                return;
            }

            subscription.window.removeListener('maximize', subscription.listener);
            subscription.window.removeListener('unmaximize', subscription.listener);
            windowControlSubscriptions.delete(id);
        },
    },
};

contextBridge.exposeInMainWorld('Native', Native);

// -------------------------------------------------------------------
// Log events
// -------------------------------------------------------------------
ipcRenderer.on('log', (event, { level, message, context }) => {
    if (level === 'error') {
        console.error(`[${level}] ${message}`, context);
    } else if (level === 'warn') {
        console.warn(`[${level}] ${message}`, context);
    } else {
        console.log(`[${level}] ${message}`, context);
    }
});

// -------------------------------------------------------------------
// Livewire event listeners
// -------------------------------------------------------------------
ipcRenderer.on('native-event', (event, data) => {
    // Strip leading slashes
    data.event = data.event.replace(/^(\\)+/, '');

    // Forward event to renderer context
    // Handler injected via Events\LivewireDispatcher
    window.postMessage(
        {
            type: 'native-event',
            event: data.event,
            payload: data.payload,
        },
        '*',
    );
});

// -------------------------------------------------------------------
// Let the client know preload is fully evaluated
// -------------------------------------------------------------------
contextBridge.exposeInMainWorld(
    'native:initialized',
    (function () {
        // This is admittedly a bit hacky. Due to context isolation
        // we don't have direct access to the renderer window object,
        // but by assigning a bridge function that executes itself inside
        // the renderer context we can hack around it.

        // It's recommended to use window.postMessage & dispatch an
        // event from the renderer itself, but we're loading webcontent
        // from localhost. We don't have a renderer process we can access.
        // Though this is hacky it works well and is the simplest way to do this
        // without sprinkling additional logic all over the place.

        window.dispatchEvent(new CustomEvent('native:init'));

        return true;
    })(),
);
