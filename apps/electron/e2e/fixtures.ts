import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _electron, expect, test as base } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * End-to-end fixtures: every test gets the built app on a fresh data folder,
 * past first-launch setup. Helpers drive the app the way a user does
 * (keyboard, visible text, roles), so the tests survive refactoring.
 */

const appDirectory = path.resolve(import.meta.dirname, '..');

type AppFixtures = {
    /** The app's data folder for this test (kept across restarts). */
    dataDirectory: string;
    /** The running app. Use `restart()` to relaunch it on the same data. */
    electronApp: ElectronApplication;
    /** Its window, past first-launch setup. */
    page: Page;
    /** Quits the app and starts it again on the same data folder. */
    restart: () => Promise<Page>;
};

export const test = base.extend<AppFixtures>({
    // eslint-disable-next-line no-empty-pattern
    dataDirectory: async ({}, use) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yeidle-e2e-'));
        await use(directory);
        fs.rmSync(directory, { recursive: true, force: true });
    },

    electronApp: async ({ dataDirectory }, use) => {
        await use(await launchApp(dataDirectory));
        // After a restart() this is the relaunched app
        await running
            .get(dataDirectory)
            ?.close()
            .catch(() => undefined);
        running.delete(dataDirectory);
    },

    page: async ({ electronApp }, use) => {
        const page = await openWindow(electronApp);
        await completeFirstLaunch(page);
        await use(page);
    },

    restart: async ({ dataDirectory }, use) => {
        await use(async () => {
            await running.get(dataDirectory)?.close();
            const app = await launchApp(dataDirectory);

            return openWindow(app);
        });
    },
});

export { expect };

/** The app currently running on each data folder. */
const running = new Map<string, ElectronApplication>();

async function launchApp(dataDirectory: string): Promise<ElectronApplication> {
    const app = await _electron.launch({
        args: [appDirectory],
        env: {
            ...process.env,
            YEIDLE_DATA_DIR: dataDirectory,
            // No NativePHP workspaces to import, and no cloud to reach
            YEIDLE_LEGACY_DIR: path.join(dataDirectory, 'no-legacy'),
            YEIDLE_CLOUD_URL: 'http://127.0.0.1:9',
            ELECTRON_RENDERER_URL: '',
        },
    });
    running.set(dataDirectory, app);

    return app;
}

async function openWindow(app: ElectronApplication): Promise<Page> {
    const page = await app.firstWindow();
    // The app navigates on startup; wait until its sidebar is up
    await expect(page.getByText('All Pages').first()).toBeVisible({
        timeout: 15_000,
    });

    return page;
}

/**
 * What a user does once on a new install: pick a theme, keep the workspace
 * on this device, and continue offline instead of signing in.
 */
async function completeFirstLaunch(page: Page): Promise<void> {
    await page.evaluate(async () => {
        const put = (url: string, body: unknown) =>
            fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify(body),
            });

        await put('/api/preferences/theme', { theme: 'light' });
        await put('/api/preferences/workspace-storage', {
            workspace_storage: 'local',
        });
    });
    await page.reload();
    await expect(page.getByText('All Pages').first()).toBeVisible();

    // The sign-in prompt opens shortly after the first page loads
    const continueOffline = page.getByRole('button', {
        name: 'Continue offline',
    });

    try {
        await continueOffline.waitFor({ timeout: 3_000 });
        await continueOffline.click();
        await expect(continueOffline).toBeHidden();
    } catch {
        // Already dismissed
    }
}

/** The page editor (TipTap). */
export function editor(page: Page) {
    return page.locator('.ProseMirror').first();
}

/**
 * The page's blocks as an indented outline, one line per block:
 * `["Apples", "  Pears"]` is Pears nested under Apples.
 */
export async function outline(page: Page): Promise<string[]> {
    return editor(page).evaluate((root) => {
        const lines: string[] = [];
        const walk = (list: Element, depth: number) => {
            for (const item of list.querySelectorAll(':scope > li')) {
                const text =
                    item.querySelector(':scope > p')?.textContent ?? '';
                lines.push(`${'  '.repeat(depth)}${text}`);
                const children = item.querySelector(':scope > ul');

                if (children) {
                    walk(children, depth + 1);
                }
            }
        };
        const top = root.querySelector(':scope > ul');

        if (top) {
            walk(top, 0);
        }

        return lines;
    });
}

/** The block containing `text`. */
export function block(page: Page, text: string) {
    return editor(page)
        .locator('li')
        .filter({ has: page.locator(':scope > p', { hasText: text }) })
        .last();
}

/** Opens Find or Create Page and returns its input. */
export async function openSearch(page: Page) {
    await page.keyboard.press('Alt+e');
    const search = page.getByPlaceholder('Find or Create Page');
    await expect(search).toBeVisible();

    return search;
}

/** Creates a page through Find or Create Page and opens it. */
export async function createPage(page: Page, title: string): Promise<void> {
    const search = await openSearch(page);
    await search.fill(title);
    await page.getByText(`Create page: ${title}`).click();
    await expectOnPage(page, title);
    // A new page opens with the cursor in its first block
    await expect(editor(page)).toBeFocused();
}

/** Opens an existing page through Find or Create Page. */
export async function openPage(page: Page, title: string): Promise<void> {
    const search = await openSearch(page);
    await search.fill(title);
    await page
        .getByRole('option')
        .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(title)}\\s*$`) })
        .first()
        .click();
    await expectOnPage(page, title);
}

export async function expectOnPage(page: Page, title: string): Promise<void> {
    await expect(
        page.getByRole('heading', { level: 1, name: title, exact: true }),
    ).toBeVisible();
}

/**
 * Waits until the app has stored `text` (the editor saves shortly after
 * typing stops), by asking the app's search for it.
 */
export async function waitForSaved(page: Page, text: string): Promise<void> {
    await expect
        .poll(
            () =>
                page.evaluate(async (query) => {
                    const response = await fetch(
                        `/api/search?q=${encodeURIComponent(query)}`,
                        { headers: { Accept: 'application/json' } },
                    );
                    const results = (await response.json()) as {
                        content: string;
                    }[];

                    return results.some((node) => node.content.includes(query));
                }, text),
            { timeout: 5_000 },
        )
        .toBe(true);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
