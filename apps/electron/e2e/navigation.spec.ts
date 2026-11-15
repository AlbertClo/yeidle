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
