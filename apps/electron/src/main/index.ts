import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { cloudFor } from '@yeidle/core/app/cloud/index';
import { createContext, fileSettings } from '@yeidle/core/app/context';
import type { Host } from '@yeidle/core/app/host';
import { createAppServer } from '@yeidle/core/app/server';
import { Workspaces } from '@yeidle/core/app/workspaces';
import { openNodeDatabase } from '@yeidle/core/db/nodeSqlite';
import { pageAttribute } from '@yeidle/core/http/inertia';
import type { InertiaPage } from '@yeidle/core/http/inertia';
import { nodeFiles } from '@yeidle/core/support/nodeFiles';
import {
    app,
    BrowserWindow,
    ipcMain,
    Menu,
    net,
    protocol,
    shell,
} from 'electron';

import {
    proxyToDevServer,
    serveStatic,
    toAppRequest,
    toResponse,
} from './protocol';

const SCHEME = 'yeidle';
const ORIGIN = `${SCHEME}://app`;
const devServerUrl = process.env.ELECTRON_RENDERER_URL?.replace(/\/$/, '');
const rendererRoot = path.join(import.meta.dirname, '../renderer');

protocol.registerSchemesAsPrivileged([
    {
        scheme: SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
            stream: true,
            codeCache: true,
        },
    },
]);

// Data folders and cloud:
//   yeidle      the installed app (your notes), signed in to Yeidle Cloud
//   yeidle-dev  runs from the source checkout (npm run dev / npm start), so
//               development never shares databases with the installed app
//               and schema changes never reach it before an upgrade; it
//               signs in to the local cloud (Sail)
// Only the checkout has the build config next to the app; packages ship
// just the build output.
const runningFromSource = fs.existsSync(
    path.join(app.getAppPath(), 'electron.vite.config.ts'),
);

app.setName('Yeidle');
app.setPath(
    'userData',
    process.env.YEIDLE_DATA_DIR ??
        path.join(
            app.getPath('appData'),
            runningFromSource ? 'yeidle-dev' : 'yeidle',
        ),
);

const host: Host = {
    platform: process.platform as Host['platform'],
    appVersion: app.getVersion(),
    dataDirectory: app.getPath('userData'),
    files: nodeFiles,
    openPath: (target) => void shell.openPath(target),
    showItemInFolder: (target) => shell.showItemInFolder(target),
    openExternal: (url) => void shell.openExternal(url),
    cloudUrl:
        process.env.YEIDLE_CLOUD_URL ??
        (runningFromSource
            ? 'http://localhost:8200'
            : 'https://app.yeidle.com'),
    deviceName: `Yeidle on ${os.hostname()}`,
    fetch: async (url) => {
        const response = await net.fetch(url);

        return {
            status: response.status,
            contentType: response.headers.get('content-type'),
            bytes: new Uint8Array(await response.arrayBuffer()),
        };
    },
};

function broadcastDocumentChanges(documentIds: string[]): void {
    for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('yeidle:documents-changed', documentIds);
    }

    // Local changes go to the cloud soon (a pulled change finds nothing to push)
    cloudFor(context).scheduler.nudge();
}

const workspaces = new Workspaces(host, openNodeDatabase, (workspace) =>
    workspace.documents.onChange(broadcastDocumentChanges),
);
const context = createContext(host, workspaces, fileSettings(host));
let htmlTemplate: string | null = null;

const server = createAppServer(context, {
    version: app.getVersion(),
    renderHtml: (page: InertiaPage, appearance) =>
        (htmlTemplate ?? '')
            .replace(
                '<html lang="en">',
                `<html lang="en" data-theme="${appearance.theme}"${appearance.dark ? ' class="dark"' : ''}>`,
            )
            .replace(
                '<div id="app"></div>',
                `<div id="app" data-page="${pageAttribute(page)}"></div>`,
            ),
});

async function loadHtmlTemplate(): Promise<void> {
    htmlTemplate = devServerUrl
        ? await (await fetch(`${devServerUrl}/`)).text()
        : fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
}

async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const probe = {
        method: request.method,
        url,
        headers: {},
        body: {},
        files: {},
    };

    if (server.matches(probe)) {
        if (devServerUrl && request.headers.get('x-inertia') === null) {
            // Vite rewrites index.html on each request in development
            await loadHtmlTemplate();
        }

        return toResponse(await server.handle(await toAppRequest(request)));
    }

    return devServerUrl
        ? proxyToDevServer(devServerUrl, request)
        : serveStatic(rendererRoot, url.pathname);
}

function createWindow(): BrowserWindow {
    const window = new BrowserWindow({
        width: 1280,
        height: 800,
        show: false,
        frame: false,
        transparent: true,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(import.meta.dirname, '../preload/index.mjs'),
            sandbox: false,
        },
    });

    // In-app navigation is owned by Yeidle's location history; a second
    // Chromium history stack would make Back/Forward run twice
    const clearBrowserHistory = () =>
        window.webContents.navigationHistory.clear();
    window.webContents.on('did-navigate', clearBrowserHistory);
    window.webContents.on('did-navigate-in-page', clearBrowserHistory);

    // Mouse Back/Forward buttons go to Yeidle's history, not Chromium's
    window.on('app-command', (event, command) => {
        if (command === 'browser-backward' || command === 'browser-forward') {
            event.preventDefault();
            window.webContents.send(
                'yeidle:navigation-command',
                command === 'browser-backward' ? 'back' : 'forward',
            );
        }
    });
    window.on('swipe', (event, direction) => {
        if (direction === 'right' || direction === 'left') {
            event.preventDefault();
            window.webContents.send(
                'yeidle:navigation-command',
                direction === 'right' ? 'back' : 'forward',
            );
        }
    });

    // External links open in the browser
    window.webContents.setWindowOpenHandler(({ url }) => {
        void shell.openExternal(url);

        return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, target) => {
        if (!target.startsWith(ORIGIN)) {
            event.preventDefault();
            void shell.openExternal(target);
        }
    });

    const sendMaximized = () =>
        window.webContents.send('yeidle:maximized', window.isMaximized());
    window.on('maximize', sendMaximized);
    window.on('unmaximize', sendMaximized);

    window.once('ready-to-show', () => {
        window.maximize();
        window.show();
    });

    if (process.env.YEIDLE_SELF_CHECK) {
        selfCheck(window);
    }

    void window.loadURL(
        `${ORIGIN}/${process.env.YEIDLE_SELF_CHECK_PATH ?? ''}`,
    );

    return window;
}

/**
 * YEIDLE_SELF_CHECK=1 prints what the window rendered and any console
 * errors, then quits. For scripted smoke tests.
 */
function selfCheck(window: BrowserWindow): void {
    const messages: string[] = [];
    window.webContents.on('console-message', (event) => {
        messages.push(`[${event.level}] ${event.message}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
        messages.push(`[gone] ${details.reason}`);
    });
    window.webContents.once('did-finish-load', () => {
        setTimeout(
            async () => {
                const script = process.env.YEIDLE_SELF_CHECK_SCRIPT;
                const summary = await window.webContents.executeJavaScript(
                    script
                        ? fs.readFileSync(script, 'utf8')
                        : `JSON.stringify({ url: location.href, title: document.title, text: document.body.innerText.slice(0, 600) })`,
                );
                process.stdout.write(`${summary}\n${messages.join('\n')}\n`);
                app.quit();
            },
            Number(process.env.YEIDLE_SELF_CHECK_WAIT ?? 3000),
        );
    });
}

ipcMain.on('yeidle:window', (event, action: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);

    if (!window) {
        event.returnValue = false;

        return;
    }

    switch (action) {
        case 'minimize':
            window.minimize();
            break;
        case 'reload':
            window.webContents.reload();
            break;
        case 'close':
            window.close();
            break;
        case 'toggle-maximize':
            if (window.isMaximized()) {
                window.unmaximize();
            } else {
                window.maximize();
            }

            break;
    }

    event.returnValue = window.isMaximized();
});

void app.whenReady().then(async () => {
    // No application menu: its accelerators (Ctrl+Q, Ctrl+W, …) belong to
    // Yeidle's own shortcuts
    Menu.setApplicationMenu(null);
    await loadHtmlTemplate();
    protocol.handle(SCHEME, handleRequest);

    // Open the active workspace before the first page
    workspaces.active();
    cloudFor(context).scheduler.start();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    cloudFor(context).scheduler.stop();
    workspaces.close();
});
