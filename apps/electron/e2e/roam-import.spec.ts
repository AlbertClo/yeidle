import path from 'node:path';

import {
    block,
    editor,
    expect,
    expectOnPage,
    openPage,
    outline,
    test,
} from './fixtures';

/** The small Roam graph the core's importer tests use. */
const roamExport = path.resolve(
    import.meta.dirname,
    '../../../packages/core/src/app/import/roam/fixtures/roam-export.json',
);

test('imports a Roam export into a new workspace', async ({ page }) => {
    await page.getByRole('button', { name: 'Personal' }).click();
    await page.getByRole('menuitem', { name: 'Import' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Roam JSON export').setInputFiles(roamExport);
    await dialog.getByLabel('Destination').selectOption('__new__');
    await dialog.getByLabel('Workspace name').fill('From Roam');
    // No network in tests: keep Roam-hosted files as links
    await dialog.getByLabel('Import file uploads').uncheck();
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();

    await expect(dialog.getByText('Import complete')).toBeVisible({
        timeout: 15_000,
    });
    await dialog.getByRole('button', { name: /Open/ }).click();
    // Switching workspaces reloads the app
    await expect(page.getByRole('button', { name: 'From Roam' })).toBeVisible();
    await expect(dialog).toBeHidden();
    await page.waitForLoadState('domcontentloaded');

    // Pages, a checkbox, and a link that became a backlink
    await openPage(page, 'Project Notes');
    await expect(
        editor(page).locator('.wiki-link', { hasText: 'Reference Page' }),
    ).toBeVisible();
    await expect(block(page, 'Link to')).toHaveAttribute(
        'data-checked',
        'false',
    );

    await openPage(page, 'Reference Page');
    await expect
        .poll(() => outline(page))
        .toEqual(['Target text', '  Nested target']);
    // Roam's heading level survives
    await expect(
        block(page, 'Target text').locator(':scope > h2'),
    ).toBeVisible();
    await expect(page.locator('.backlink-item')).toContainText('Project Notes');
    await expectOnPage(page, 'Reference Page');
});
