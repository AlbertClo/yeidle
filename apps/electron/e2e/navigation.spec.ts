import {
    createPage,
    expect,
    expectOnPage,
    openSearch,
    test,
    waitForSaved,
} from './fixtures';

test.describe('finding and moving between pages', () => {
    test('All Pages lists the pages you create', async ({ page }) => {
        await createPage(page, 'Recipes');
        await createPage(page, 'Travel');

        await page.getByRole('link', { name: 'All Pages' }).first().click();

        await expect(page.getByText('Recipes', { exact: true })).toBeVisible();
        await expect(page.getByText('Travel', { exact: true })).toBeVisible();
    });

    test('search finds a page by the text of one of its blocks', async ({
        page,
    }) => {
        await createPage(page, 'Recipes');
        await page.keyboard.type('Lemon drizzle cake');
        await waitForSaved(page, 'Lemon drizzle cake');
        await createPage(page, 'Elsewhere');

        const search = await openSearch(page);
        await search.fill('drizzle');
        await page.getByRole('option', { name: /Lemon drizzle cake/ }).click();

        await expectOnPage(page, 'Recipes');
    });

    test('Back and Forward retrace the pages you visited', async ({ page }) => {
        await createPage(page, 'First');
        await createPage(page, 'Second');

        await page.getByRole('button', { name: 'Navigate back' }).click();
        await expectOnPage(page, 'First');

        await page.getByRole('button', { name: 'Navigate forward' }).click();
        await expectOnPage(page, 'Second');
    });

    test("Daily Notes opens today's page", async ({ page }) => {
        await createPage(page, 'Somewhere else');
        await page.getByRole('button', { name: 'Daily Notes' }).click();

        const today = new Date().toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
        });
        await expectOnPage(page, today);
    });

    test('Alt+P pins the page to the sidebar', async ({ page }) => {
        await createPage(page, 'Projects');
        await page.keyboard.press('Alt+p');

        const pinned = page
            .getByText('Pinned', { exact: true })
            .locator('..')
            .getByText('Projects', { exact: true });
        await expect(pinned).toBeVisible();

        await createPage(page, 'Other');
        await pinned.click();
        await expectOnPage(page, 'Projects');
    });
});

test('arrowing through All Pages scrolls one row at a time', async ({
    page,
}) => {
    // Enough pages to overflow the window
    await page.evaluate(async () => {
        for (let i = 0; i < 60; i++) {
            await fetch('/api/nodes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    content: `Page ${String(i).padStart(2, '0')}`,
                }),
            });
        }
    });
    await page.getByRole('link', { name: 'All Pages' }).first().click();
    const rows = page.locator('[data-page-row]');
    await expect(rows.nth(59)).toBeAttached();

    // The scrolling ancestor of the list, and the distance between rows
    const scrollTop = () =>
        rows.first().evaluate((row) => {
            let element: HTMLElement | null = row.parentElement;

            while (element && element.scrollHeight <= element.clientHeight) {
                element = element.parentElement;
            }

            return (element ?? document.scrollingElement!).scrollTop;
        });
    const rowStep = await rows
        .nth(1)
        .evaluate(
            (row) =>
                row.getBoundingClientRect().top -
                row.previousElementSibling!.getBoundingClientRect().top,
        );

    await rows.first().focus();
    await expect(rows.first()).toBeFocused();
    let previous = await scrollTop();
    let largestStep = 0;

    for (let i = 1; i < 45; i++) {
        await page.keyboard.press('ArrowDown');
        await expect(rows.nth(i)).toBeFocused();
        await expect(rows.nth(i)).toBeInViewport();
        const current = await scrollTop();
        largestStep = Math.max(largestStep, current - previous);
        previous = current;
    }

    expect(previous).toBeGreaterThan(0);
    expect(largestStep).toBeLessThanOrEqual(rowStep + 2);
});
