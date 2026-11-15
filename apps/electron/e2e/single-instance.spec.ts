import path from 'node:path';

import { _electron } from '@playwright/test';

import { expect, test } from './fixtures';

test('launching the app again opens a window in the running app', async ({
    electronApp,
    page,
    dataDirectory,
}) => {
    const windowCount = () =>
        electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        );
    await expect(page.getByText('All Pages').first()).toBeVisible();
    expect(await windowCount()).toBe(1);

    // The second process hands over to the running app and quits, so
    // Playwright may report it as failing to launch
    await _electron
        .launch({
            args: [path.resolve(import.meta.dirname, '..')],
            env: {
                ...process.env,
                YEIDLE_DATA_DIR: dataDirectory,
                YEIDLE_CLOUD_URL: 'http://127.0.0.1:9',
                ELECTRON_RENDERER_URL: '',
            },
            timeout: 10_000,
        })
        .then((second) => second.close())
        .catch(() => undefined);

    await expect.poll(windowCount).toBe(2);
});

test('the new-window shortcut and command open another window', async ({
    electronApp,
    page,
}) => {
    const windowCount = () =>
        electronApp.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        );
    await expect(page.getByText('All Pages').first()).toBeVisible();

    await page.keyboard.press('Control+Shift+N');
    await expect.poll(windowCount).toBe(2);

    await page.getByText('Command Palette').first().click();
    await page.getByPlaceholder('Type a command…').fill('new window');
    await page.keyboard.press('Enter');
    await expect.poll(windowCount).toBe(3);
});
