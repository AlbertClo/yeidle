/**
 * What the core needs from the platform it runs on. Desktop implements this
 * with Node's fs and Electron's shell.
 */

export interface Files {
    exists(path: string): boolean;
    isFile(path: string): boolean;
    isDirectory(path: string): boolean;
    readFile(path: string): Uint8Array;
    readText(path: string): string;
    writeFile(path: string, data: Uint8Array | string): void;
    appendFile(path: string, data: Uint8Array): void;
    mkdir(path: string): void;
    rename(from: string, to: string): void;
    /** Hard link, falling back to a copy where links aren't possible. */
    link(from: string, to: string): void;
    copy(from: string, to: string): void;
    unlink(path: string): void;
    removeDirectory(path: string): void;
    size(path: string): number;
    list(path: string): string[];
    join(...parts: string[]): string;
    dirname(path: string): string;
    basename(path: string): string;
}

export interface Host {
    platform: 'linux' | 'darwin' | 'win32' | 'android' | 'ios';
    appVersion: string;
    /** Directory for app-wide data (workspace index, settings). */
    dataDirectory: string;
    files: Files;
    /** Opens a file with the operating system's default app. */
    openPath(path: string): void;
    showItemInFolder(path: string): void;
    openExternal(url: string): void;
    /** Downloads a URL (Roam attachments). */
    fetch(
        url: string,
    ): Promise<{
        status: number;
        contentType: string | null;
        bytes: Uint8Array;
    }>;
}
