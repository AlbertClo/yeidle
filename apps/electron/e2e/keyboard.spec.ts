import {
    clickInto,
    importRoam,
    openPage,
    createPage,
    editor,
    expect,
    expectOnPage,
    focusedValue,
    insertLink,
    outline,
    pasteImage,
    press,
    pressUntil,
    selectedNode,
    test,
} from './fixtures';

test.describe('editor keyboard', () => {
    test('Alt+Shift+Up and Down move a block with its children', async ({
        page,
    }) => {
        await createPage(page, 'Order');
        await page.keyboard.type('First');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Second');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Child of second');
        await page.keyboard.press('Tab');
        await page.keyboard.press('ArrowUp');

        await page.keyboard.press('Alt+Shift+ArrowUp');
        await expect
            .poll(() => outline(page))
            .toEqual(['Second', '  Child of second', 'First']);

        await page.keyboard.press('Alt+Shift+ArrowDown');
        await expect
            .poll(() => outline(page))
            .toEqual(['First', 'Second', '  Child of second']);
    });

    test('ArrowUp from the first block goes to the title, ArrowDown comes back', async ({
        page,
    }) => {
        await createPage(page, 'Arrows');
        await page.keyboard.type('Only block');

        await pressUntil(
            page,
            'ArrowUp',
            async () => (await focusedValue(page)) === 'Arrows',
        );

        await press(page, 'ArrowDown');
        await expect(editor(page)).toBeFocused();
        await page.keyboard.type('!');
        await expect.poll(() => outline(page)).toEqual(['!Only block']);
    });

    test('a pasted image becomes its own block; Enter on it opens its menu', async ({
        page,
    }) => {
        await createPage(page, 'Photos');
        await page.keyboard.type('Above');
        await page.keyboard.press('Enter');
        await pasteImage(page, 'heron.png');

        // The pasted file is selected; ArrowDown starts the next block
        await expect(selectedNode(page)).toHaveAttribute(
            'originalname',
            'heron.png',
        );
        await press(page, 'ArrowDown');
        await page.keyboard.type('Below');
        await expect
            .poll(() => outline(page))
            .toEqual(['Above', '[file: heron.png]', 'Below']);

        // Selecting the file and pressing Enter opens its menu
        await editor(page).locator('[data-file-node]').click();
        await expect(selectedNode(page)).toHaveCount(1);
        await page.keyboard.press('Enter');
        for (const action of ['Download', 'Open', 'Open folder', 'Delete']) {
            await expect(page.getByText(action, { exact: true })).toBeVisible();
        }
    });

    test('Escape on the file menu returns to the file, and writing continues below it', async ({
        page,
    }) => {
        await createPage(page, 'Photos');
        await page.keyboard.type('Above');
        await page.keyboard.press('Enter');
        await pasteImage(page, 'heron.png');
        await page.keyboard.press('Enter');
        await expect(
            page.getByText('Open folder', { exact: true }),
        ).toBeVisible();

        await page.keyboard.press('Escape');
        await expect(
            page.getByText('Open folder', { exact: true }),
        ).toBeHidden();
        await expect(selectedNode(page)).toHaveAttribute(
            'originalname',
            'heron.png',
        );

        await page.keyboard.press('ArrowDown');
        await page.keyboard.type('Below');
        await expect
            .poll(() => outline(page))
            .toEqual(['Above', '[file: heron.png]', 'Below']);
    });

    test('arrow keys stop beside an image block, then select it, then move past it', async ({
        page,
    }) => {
        await createPage(page, 'Photos');
        await page.keyboard.type('Above');
        await page.keyboard.press('Enter');
        await pasteImage(page, 'heron.png');
        await press(page, 'ArrowDown');
        await page.keyboard.type('Below');

        const gapCursor = editor(page).locator('.ProseMirror-gapcursor');
        const caretText = () =>
            page.evaluate(() => getSelection()?.anchorNode?.textContent ?? '');

        // Up from "Below": beside the image, then the image, then "Above"
        await pressUntil(
            page,
            'ArrowUp',
            async () => (await gapCursor.count()) > 0,
        );
        await press(page, 'ArrowUp');
        await expect(selectedNode(page)).toHaveAttribute(
            'originalname',
            'heron.png',
        );
        await press(page, 'ArrowUp');
        await expect.poll(caretText).toBe('Above');

        // And back down the same way
        await pressUntil(
            page,
            'ArrowDown',
            async () => (await gapCursor.count()) > 0,
        );
        await press(page, 'ArrowDown');
        await expect(selectedNode(page)).toHaveAttribute(
            'originalname',
            'heron.png',
        );
        await press(page, 'ArrowDown');
        await expect.poll(caretText).toBe('Below');
    });

    test('Enter on a selected link offers Follow link, which opens the page', async ({
        page,
    }) => {
        await createPage(page, 'Herons');
        await createPage(page, 'Walk');
        await page.keyboard.type('Saw ');
        await insertLink(page, 'Herons');

        await page.keyboard.press('ArrowLeft');
        await expect(selectedNode(page)).toHaveClass(/wiki-link/);
        await page.keyboard.press('Enter');

        await page.getByText('Follow link').click();
        await expectOnPage(page, 'Herons');
    });

    test('Ctrl+Q follows a selected link directly', async ({ page }) => {
        await createPage(page, 'Egrets');
        await createPage(page, 'Walk');
        await insertLink(page, 'Egrets');

        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Control+q');
        await expectOnPage(page, 'Egrets');
    });

    test('Update link points a link at another page', async ({ page }) => {
        await createPage(page, 'Herons');
        await createPage(page, 'Egrets');
        await createPage(page, 'Walk');
        await insertLink(page, 'Herons');

        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('Enter');
        await page.getByText('Update link').click();

        const dialog = page.getByRole('dialog', { name: 'Update link' });
        await dialog.getByPlaceholder('Search for a page...').fill('Egrets');
        await dialog
            .getByRole('button', { name: 'Egrets', exact: true })
            .click();
        // The label keeps the old title until reset
        await dialog.getByTitle('Reset to page title').click();
        await dialog.getByRole('button', { name: 'Save' }).click();

        const link = editor(page).locator('.wiki-link');
        await expect(link).toHaveText(/Egrets/);
        await link.click();
        await page.keyboard.press('Control+q');
        await expectOnPage(page, 'Egrets');
    });
});

test('ArrowDown through a block that holds only a wrapped link reaches the next block', async ({
    page,
}) => {
    const url =
        'https://console.cloud.google.com/agent-platform/provisioned-throughput/orders?authuser=5&project=gen-lang-client-0859365050&supportedpurview=project&padding=long-enough-to-wrap-over-several-lines';
    await importRoam(page, [
        {
            title: 'Links',
            uid: 'links',
            children: [
                {
                    string: 'Make sure it is canceled.',
                    uid: 'canceled',
                    children: [{ string: url, uid: 'link-only' }],
                },
                { string: 'Look at GCP', uid: 'gcp' },
                ...Array.from({ length: 20 }, (_, i) => ({
                    string: `Later block ${i}`,
                    uid: `later-${i}`,
                })),
            ],
        },
    ]);
    await openPage(page, 'Links');
    const caretText = () =>
        page.evaluate(() => getSelection()?.anchorNode?.textContent ?? '');

    await clickInto(page, 'Make sure it is canceled.');
    await press(page, 'ArrowDown');
    await expect.poll(caretText).toContain('provisioned-throughput');
    await press(page, 'ArrowDown');
    await expect.poll(caretText).toBe('Look at GCP');
});
