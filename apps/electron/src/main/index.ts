import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { app, BrowserWindow, ipcMain } from 'electron';

function createWindow(): void {
    const window = new BrowserWindow({
        width: 1100,
        height: 800,
        autoHideMenuBar: true,
        webPreferences: {
            preload: join(import.meta.dirname, '../preload/index.mjs'),
            sandbox: false,
        },
    });

    // YEIDLE_SELF_CHECK=1 prints the phase 0 checks and quits (for CI/agents)
    if (process.env.YEIDLE_SELF_CHECK) {
        window.webContents.once('did-finish-load', () => {
            setTimeout(async () => {
                const checks = await window.webContents.executeJavaScript(
                    "[...document.querySelectorAll('[data-check]')].map((el) => el.textContent).join('\\n')",
                );
                process.stdout.write(`${checks}\n`);
                app.quit();
            }, 1500);
        });
    }

    if (process.env.ELECTRON_RENDERER_URL) {
        void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
        void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
    }
}

// Phase 0 check: SQLite with FTS5 trigram search, without a native module
ipcMain.handle('spike:sqlite', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
        "CREATE VIRTUAL TABLE search USING fts5(content, tokenize='trigram');" +
            "INSERT INTO search VALUES ('hello from node:sqlite');",
    );
    const version = db.prepare('SELECT sqlite_version() AS version').get() as {
        version: string;
    };
    const hits = db.prepare("SELECT content FROM search WHERE search MATCH 'node'").all();
    db.close();

    return { version: version.version, hits };
});

void app.whenReady().then(() => {
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
