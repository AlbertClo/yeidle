import {
    block,
    createPage,
    expect,
    outline,
    test,
    waitForSaved,
} from './fixtures';

test.describe('editing', () => {
    test('Enter starts a new block; Tab and Shift+Tab nest and un-nest', async ({
        page,
    }) => {
        await createPage(page, 'Groceries');

        await page.keyboard.type('Fruit');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Apples');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Pears');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.type('Bread');

        await expect
            .poll(() => outline(page))
            .toEqual(['Fruit', '  Apples', '  Pears', 'Bread']);
    });

    test('Ctrl+Enter cycles a block through unchecked, checked and plain', async ({
        page,
    }) => {
        await createPage(page, 'Todo');
        await page.keyboard.type('Water plants');
        const task = block(page, 'Water plants');

        await page.keyboard.press('Control+Enter');
        await expect(task).toHaveAttribute('data-checked', 'false');

        await page.keyboard.press('Control+Enter');
        await expect(task).toHaveAttribute('data-checked', 'true');

        await page.keyboard.press('Control+Enter');
        await expect(task).not.toHaveAttribute('data-checked');
    });

    test('Backspace in an empty block removes it', async ({ page }) => {
        await createPage(page, 'Draft');
        await page.keyboard.type('Keep');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Backspace');
        await page.keyboard.type(' this');

        await expect.poll(() => outline(page)).toEqual(['Keep this']);
    });

    test('what you write is still there after restarting the app', async ({
        page,
        restart,
    }) => {
        await createPage(page, 'Journal');
        await page.keyboard.type('Morning walk');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Saw a heron');
        await page.keyboard.press('Tab');
        await waitForSaved(page, 'Saw a heron');

        const reopened = await restart();
        await reopened.getByRole('link', { name: 'All Pages' }).first().click();
        await reopened.getByText('Journal', { exact: true }).first().click();

        await expect
            .poll(() => outline(reopened))
            .toEqual(['Morning walk', '  Saw a heron']);
    });
});
