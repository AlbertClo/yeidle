import {
    block,
    clickInto,
    createPage,
    editor,
    expect,
    expectOnPage,
    insertLink,
    openPage,
    outline,
    pressUntil,
    renamePage,
    test,
    waitForSaved,
} from './fixtures';

/** A date as the daily note titles it ("November 15, 2026"). */
function dailyTitle(date: Date): string {
    return date.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
}

function daysFromToday(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);

    return date;
}

test.describe('collapsing', () => {
    test('Ctrl+Up collapses a block, Ctrl+Down expands it, and it stays collapsed', async ({
        page,
        restart,
    }) => {
        await createPage(page, 'Tree');
        await page.keyboard.type('Parent');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Child');
        await page.keyboard.press('Tab');
        await waitForSaved(page, 'Child');

        const parent = block(page, 'Parent');
        const child = editor(page).getByText('Child', { exact: true });
        await clickInto(page, 'Parent');

        await pressUntil(
            page,
            'Control+ArrowUp',
            async () =>
                (await parent.getAttribute('aria-expanded')) === 'false',
        );
        await expect(child).toBeHidden();

        await pressUntil(
            page,
            'Control+ArrowDown',
            async () => (await parent.getAttribute('aria-expanded')) === 'true',
        );
        await expect(child).toBeVisible();

        // Collapsed state is remembered
        await pressUntil(
            page,
            'Control+ArrowUp',
            async () =>
                (await parent.getAttribute('aria-expanded')) === 'false',
        );
        await page.waitForTimeout(500);
        const reopened = await restart();
        await reopened.getByRole('link', { name: 'All Pages' }).first().click();
        await reopened.getByText('Tree', { exact: true }).first().click();
        await expectOnPage(reopened, 'Tree');
        await expect(block(reopened, 'Parent')).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        await expect(
            editor(reopened).getByText('Child', { exact: true }),
        ).toBeHidden();
    });
});

test.describe('daily notes', () => {
    test('Ctrl+Shift+[ and ] step between days', async ({ page }) => {
        await page.getByRole('button', { name: 'Daily Notes' }).click();
        await expectOnPage(page, dailyTitle(daysFromToday(0)));

        await page.keyboard.press('Control+Shift+BracketLeft');
        await expectOnPage(page, dailyTitle(daysFromToday(-1)));

        await page.keyboard.press('Control+Shift+BracketLeft');
        await expectOnPage(page, dailyTitle(daysFromToday(-2)));

        await page.keyboard.press('Control+Shift+BracketRight');
        await expectOnPage(page, dailyTitle(daysFromToday(-1)));
    });

    test('what you write in a daily note stays on that day', async ({
        page,
    }) => {
        await page.getByRole('button', { name: 'Daily Notes' }).click();
        await editor(page).click();
        await page.keyboard.type('Dentist at 3');
        await waitForSaved(page, 'Dentist at 3');

        await page.keyboard.press('Control+Shift+BracketLeft');
        await expectOnPage(page, dailyTitle(daysFromToday(-1)));
        await expect(editor(page)).not.toContainText('Dentist at 3');

        await page.keyboard.press('Control+Shift+BracketRight');
        await expect.poll(() => outline(page)).toEqual(['Dentist at 3']);
    });
});

test.describe('renaming', () => {
    test('editing the title renames the page everywhere it is listed', async ({
        page,
    }) => {
        await createPage(page, 'Draft title');
        await page.keyboard.type('Body');
        await waitForSaved(page, 'Body');

        await renamePage(page, 'Final title');
        await waitForSaved(page, 'Final title');

        // Search finds it by the new title
        await openPage(page, 'Final title');

        await page.getByRole('link', { name: 'All Pages' }).first().click();
        const main = page.getByRole('main');
        await expect(
            main.getByText('Final title', { exact: true }).first(),
        ).toBeVisible();
        await expect(
            main.getByText('Draft title', { exact: true }),
        ).toHaveCount(0);
    });

    test('links to a renamed page still lead to it', async ({ page }) => {
        await createPage(page, 'Old name');
        await createPage(page, 'Linker');
        await insertLink(page, 'Old name');
        await waitForSaved(page, 'Old name');

        await editor(page).locator('.wiki-link').click();
        await page.keyboard.press('Control+q');
        await expectOnPage(page, 'Old name');
        await renamePage(page, 'New name');
        await waitForSaved(page, 'New name');

        await page.getByRole('button', { name: 'Navigate back' }).click();
        await expectOnPage(page, 'Linker');
        await editor(page).locator('.wiki-link').click();
        await page.keyboard.press('Control+q');
        await expectOnPage(page, 'New name');
    });
});
