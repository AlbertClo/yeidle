import {
    createPage,
    editor,
    expect,
    expectOnPage,
    insertLink,
    openPage,
    test,
    waitForSaved,
} from './fixtures';

test.describe('links', () => {
    test('[[ links to an existing page, which then lists the backlink', async ({
        page,
    }) => {
        await createPage(page, 'Herons');
        await page.keyboard.type('Wading birds');
        await waitForSaved(page, 'Wading birds');

        await createPage(page, 'Morning walk');
        await page.keyboard.type('Saw two ');
        await insertLink(page, 'Herons');
        await page.keyboard.type(' by the river');

        const link = editor(page).locator('.wiki-link', { hasText: 'Herons' });
        await expect(link).toBeVisible();
        await waitForSaved(page, 'by the river');

        await openPage(page, 'Herons');
        await expect(page.locator('.backlink-item')).toContainText(
            'Morning walk',
        );
    });

    test('[[ with a new title creates the page', async ({ page }) => {
        await createPage(page, 'Reading list');
        await page.keyboard.type('[[Dune');
        await page
            .locator('.wiki-suggestion-item')
            .filter({ hasText: 'Create: Dune' })
            .click();
        await waitForSaved(page, 'Dune');

        await editor(page)
            .locator('.wiki-link', { hasText: 'Dune' })
            .click({
                modifiers: ['Control'],
            });
        await page.keyboard.press('Control+q');
        await expectOnPage(page, 'Dune');
    });
});
