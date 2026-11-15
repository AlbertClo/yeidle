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

export async function launchApp(
    dataDirectory: string,
    env: Record<string, string> = {},
): Promise<ElectronApplication> {
    const app = await _electron.launch({
        args: [appDirectory],
        env: {
            ...process.env,
            YEIDLE_DATA_DIR: dataDirectory,
            // No cloud to reach
            YEIDLE_CLOUD_URL: 'http://127.0.0.1:9',
            ELECTRON_RENDERER_URL: '',
            ...env,
        },
    });
    running.set(dataDirectory, app);
    // Nothing a test clicks may open outside the app (links in the browser,
    // files in their apps)
    await app.evaluate(({ shell }) => {
        shell.openExternal = async () => undefined;
        shell.openPath = async () => '';
        shell.showItemInFolder = () => undefined;
    });

    return app;
}

export async function openWindow(app: ElectronApplication): Promise<Page> {
    const page = await app.firstWindow();
    // Behave as the focused window even when it isn't (another app has
    // focus, or several tests run at once); the editor depends on focus
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
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
export async function completeFirstLaunch(page: Page): Promise<void> {
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
 * `["Apples", "  Pears"]` is Pears nested under Apples. A block holding a
 * file reads `[file: name]`.
 */
export async function outline(page: Page): Promise<string[]> {
    return editor(page).evaluate((root) => {
        const lines: string[] = [];
        const walk = (list: Element, depth: number) => {
            for (const item of list.querySelectorAll(':scope > li')) {
                const file = item
                    .querySelector(':scope > [data-file-node]')
                    ?.getAttribute('originalname');
                const textblock = item
                    .querySelector(
                        ':scope > :is(p, h1, h2, h3, h4, h5, h6, pre)',
                    )
                    ?.cloneNode(true) as Element | undefined;
                // Other windows' cursors are decorations, not text
                textblock
                    ?.querySelectorAll('.remote-caret')
                    .forEach((caret) => caret.remove());
                const text = file
                    ? `[file: ${file}]`
                    : (textblock?.textContent ?? '');
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
        .filter({
            has: page.locator(':scope > :is(p, h1, h2, h3, h4, h5, h6, pre)', {
                hasText: text,
            }),
        })
        .last();
}

/** Opens Find or Create Page and returns its input. */
export async function openSearch(page: Page) {
    const search = page.getByPlaceholder('Find or Create Page');
    // Retried: a shortcut pressed while the app is still navigating is lost
    await expect(async () => {
        if (!(await search.isVisible())) {
            await page.keyboard.press('Alt+e');
        }

        await expect(search).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000 });

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
                        text: string;
                    }[];

                    return results.some((result) =>
                        result.text.includes(query),
                    );
                }, text),
            { timeout: 5_000 },
        )
        .toBe(true);
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Inserts a link to an existing page at the cursor, as a user does with [[. */
export async function insertLink(page: Page, title: string): Promise<void> {
    await page.keyboard.type(`[[${title}`);
    await page
        .locator('.wiki-suggestion-item')
        .filter({ hasText: new RegExp(`^\\s*${escapeRegExp(title)}\\s*$`) })
        .click();
    await expect(
        editor(page).locator('.wiki-link', { hasText: title }).last(),
    ).toBeVisible();
    // The editor takes focus back on the next frame
    await expect(editor(page)).toBeFocused();
}

/** Pastes a small PNG into the editor at the cursor. */
export async function pasteImage(page: Page, name = 'dot.png'): Promise<void> {
    await editor(page).evaluate((element, fileName) => {
        // A 1×1 PNG
        const png = Uint8Array.from(
            atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            ),
            (character) => character.charCodeAt(0),
        );
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([png], fileName, { type: 'image/png' }));
        element.dispatchEvent(
            new ClipboardEvent('paste', {
                clipboardData: clipboard,
                bubbles: true,
                cancelable: true,
            }),
        );
    }, name);
    await expect(
        editor(page).locator(`[data-file-node][originalname="${name}"]`),
    ).toBeVisible();
}

/** The value of the focused text field (e.g. the page title). */
export function focusedValue(page: Page): Promise<string | null> {
    return page.evaluate(() =>
        document.activeElement instanceof HTMLInputElement
            ? document.activeElement.value
            : null,
    );
}

/** The node the editor has selected as a whole (a link, a file), if any. */
export function selectedNode(page: Page) {
    return editor(page).locator('.ProseMirror-selectednode');
}

/**
 * Presses a key `times` times at a person's pace. The editor's own arrow
 * handling reads the selection the browser has just moved, so presses fired
 * back to back can arrive before it has caught up.
 */
export async function press(page: Page, key: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) {
        await page.keyboard.press(key);
        await page.waitForTimeout(80);
    }
}

/**
 * Presses `key` at a person's pace until `reached()` is true, at most
 * `limit` times. For keys whose exact count isn't the point (arrowing up
 * through a line before leaving the block).
 */
export async function pressUntil(
    page: Page,
    key: string,
    reached: () => Promise<boolean>,
    limit = 5,
): Promise<void> {
    for (let i = 0; i < limit; i++) {
        if (await reached()) {
            return;
        }

        await press(page, key);
    }

    expect(await reached(), `${key} ×${limit} didn't get there`).toBe(true);
}

/** Clicks into the block containing `text` and waits for the caret there. */
export async function clickInto(page: Page, text: string): Promise<void> {
    await block(page, text).locator(':scope > p').click();
    await expect
        .poll(() =>
            page.evaluate(() => getSelection()?.anchorNode?.textContent ?? ''),
        )
        .toContain(text);
}

/** Renames the open page by editing its title. */
export async function renamePage(page: Page, title: string): Promise<void> {
    await page.getByRole('heading', { level: 1 }).click();
    // The heading turns into a text field
    await expect.poll(() => focusedValue(page)).not.toBeNull();
    await page.keyboard.press('Control+a');
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await expectOnPage(page, title);
}

/** Puts the caret at the end of the block containing `text`. */
export async function caretToEnd(page: Page, text: string): Promise<void> {
    await clickInto(page, text);
    await block(page, text)
        .locator(':scope > :is(p, h1, h2, h3, h4, h5, h6, pre)')
        .evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            range.collapse(false);
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
        });
    await page.waitForTimeout(80);
}

type RoamBlock = { string: string; uid: string; children?: RoamBlock[] };

/**
 * Imports Roam pages into the open workspace through the Import dialog, for
 * content the editor can't easily produce by typing (e.g. a block holding
 * only a link, with no trailing space).
 */
export async function importRoam(
    page: Page,
    pages: { title: string; uid: string; children: RoamBlock[] }[],
): Promise<void> {
    const file = path.join(
        os.tmpdir(),
        `yeidle-e2e-roam-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
    );
    fs.writeFileSync(file, JSON.stringify(pages));

    try {
        await page.getByRole('button', { name: 'Personal' }).click();
        await page.getByRole('menuitem', { name: 'Import' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Roam JSON export').setInputFiles(file);
        // The open workspace (the first after "Create a new workspace")
        await dialog.getByLabel('Destination').selectOption({ index: 1 });
        await dialog.getByLabel('Import file uploads').uncheck();
        await dialog
            .getByRole('button', { name: 'Import', exact: true })
            .click();
        await expect(dialog.getByText('Import complete')).toBeVisible({
            timeout: 15_000,
        });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
    } finally {
        fs.rmSync(file, { force: true });
    }
}
