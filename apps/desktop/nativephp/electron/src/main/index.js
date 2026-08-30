import NativePHP from '#plugin';
import { app } from 'electron';
import path from 'path';

// Inherit User's PATH in Process & ChildProcess
import fixPath from 'fix-path';
fixPath();

const navigationCommandChannel = 'yeidle:navigation-command';

app.on('browser-window-created', (_event, window) => {
    const clearBrowserHistory = () => {
        window.webContents.navigationHistory.clear();
    };

    // In-app navigation is owned by Yeidle's location history. Keeping a
    // second Chromium history stack causes Back/Forward to run twice and is
    // ambiguous when the same page occurs at several cursor locations.
    window.webContents.on('did-navigate', clearBrowserHistory);
    window.webContents.on('did-navigate-in-page', clearBrowserHistory);

    // Preserve mouse Back/Forward buttons while bypassing Chromium history.
    window.webContents.on('app-command', (event, command) => {
        if (command === 'browser-backward' || command === 'browser-forward') {
            event.preventDefault();
            window.webContents.send(navigationCommandChannel, command === 'browser-backward' ? 'back' : 'forward');
        }
    });
});

const buildPath = path.resolve(import.meta.dirname, import.meta.env.MAIN_VITE_NATIVEPHP_BUILD_PATH);
const defaultIcon = path.join(buildPath, 'icon.png');
const certificate = path.join(buildPath, 'cacert.pem');

const executable = process.platform === 'win32' ? 'php.exe' : 'php';
const phpBinary = path.join(buildPath, 'php', executable);
const appPath = path.join(buildPath, 'app');

/**
 * Turn on the lights for the NativePHP app.
 */
NativePHP.bootstrap(app, defaultIcon, phpBinary, certificate, appPath);
