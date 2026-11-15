import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

/**
 * `window.Native`: the same window-control API the NativePHP build exposed,
 * so the renderer code didn't have to change, plus document change events.
 */

type Direction = 'back' | 'forward';

let nextSubscriptionId = 1;
type Listener = (event: IpcRendererEvent, ...args: unknown[]) => void;

const subscriptions = new Map<
    number,
    { channel: string; listener: Listener }
>();

function subscribe<T>(channel: string, callback: (value: T) => void): number {
    const id = nextSubscriptionId++;
    const listener = (_event: IpcRendererEvent, value: T) => callback(value);
    ipcRenderer.on(channel, listener);
    subscriptions.set(id, {
        channel,
        listener: listener as unknown as Listener,
    });

    return id;
}

function unsubscribe(id: number): void {
    const subscription = subscriptions.get(id);

    if (subscription) {
        ipcRenderer.removeListener(subscription.channel, subscription.listener);
        subscriptions.delete(id);
    }
}

const windowAction = (action: string): boolean =>
    ipcRenderer.sendSync('yeidle:window', action);

const Native = {
    windowControls: {
        minimize: () => void windowAction('minimize'),
        reload: () => void windowAction('reload'),
        close: () => void windowAction('close'),
        newWindow: () => void windowAction('new-window'),
        toggleMaximize: () => windowAction('toggle-maximize'),
        isMaximized: () => windowAction('state'),
        subscribeNavigationCommand: (
            callback: (direction: Direction) => void,
        ) => subscribe('yeidle:navigation-command', callback),
        unsubscribeNavigationCommand: unsubscribe,
        subscribeMaximizedChange: (callback: (maximized: boolean) => void) =>
            subscribe('yeidle:maximized', callback),
        unsubscribeMaximizedChange: unsubscribe,
    },
    subscribeDocumentChanges: (callback: (documentIds: string[]) => void) => {
        const id = subscribe('yeidle:documents-changed', callback);

        return () => unsubscribe(id);
    },
};

contextBridge.exposeInMainWorld('Native', Native);
