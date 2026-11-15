import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ElectronApplication, Page } from '@playwright/test';

import {
    caretToEnd,
    completeFirstLaunch,
    createPage,
    expect,
    expectOnPage,
    launchApp,
    openPage,
    openWindow,
    outline,
    test,
    waitForSaved,
} from './fixtures';

/**
 * Two app instances on one cloud workspace. Opt-in, against a running cloud
 * (apps/web on Sail):
 *
 *   YEIDLE_E2E_CLOUD_URL=http://localhost:8200 \
 *   YEIDLE_E2E_CLOUD_TOKEN=$(cd ../web && ./vendor/bin/sail artisan token:issue you@example.com) \
 *   npx playwright test e2e/cloud-sync.spec.ts
 *
 * Signing in needs a browser, so each device starts with the session the
 * sign-in would have stored. The test creates a throwaway cloud workspace
 * and deletes it at the end.
 */
const cloudUrl = process.env.YEIDLE_E2E_CLOUD_URL;
const token = process.env.YEIDLE_E2E_CLOUD_TOKEN;

type Device = { app: ElectronApplication; page: Page; directory: string };

async function signedInDevice(userId: string): Promise<Device> {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'yeidle-e2e-sync-'),
    );
    fs.writeFileSync(
        path.join(directory, 'cloud-account.json'),
        JSON.stringify({
            version: 1,
            pending: null,
            account: {
                cloud_url: cloudUrl,
                token,
                user: { id: userId, name: 'E2E' },
                workspaces: [],
                preferences: { key_bindings: {} },
            },
        }),
    );
    const app = await launchApp(directory, { YEIDLE_CLOUD_URL: cloudUrl! });
    const page = await openWindow(app);
    await completeFirstLaunch(page);

    return { app, page, directory };
}

/** Calls the app's own API from its window. */
function api(page: Page, method: string, url: string) {
    return page.evaluate(
        async ([requestMethod, requestUrl]) => {
            const response = await fetch(requestUrl, {
                method: requestMethod,
                headers: { Accept: 'application/json' },
            });

            return { status: response.status, body: await response.json() };
        },
        [method, url] as const,
    );
}

test.describe('cloud sync', () => {
    test.skip(
        !cloudUrl || !token,
        'Set YEIDLE_E2E_CLOUD_URL and YEIDLE_E2E_CLOUD_TOKEN',
    );
    test.setTimeout(90_000);

    test("two devices see each other's edits and cursors live", async () => {
        const user = await (
            await fetch(`${cloudUrl}/api/user`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
            })
        ).json();
        const devices: Device[] = [];
        let workspaceId: string | null = null;

        try {
            // Device A: syncs its workspace to the cloud
            const a = await signedInDevice(String(user.id));
            devices.push(a);
            workspaceId = (await api(a.page, 'GET', '/api/workspaces')).body
                .active_workspace_id as string;
            expect(
                (
                    await api(
                        a.page,
                        'POST',
                        `/api/workspaces/${workspaceId}/sync`,
                    )
                ).status,
            ).toBe(200);
            expect(
                (
                    await api(
                        a.page,
                        'POST',
                        '/api/account/sync-active-workspace',
                    )
                ).body,
            ).toMatchObject({ synced: true });
            await a.page.reload();
            await createPage(a.page, 'Shared');
            await a.page.keyboard.type('Written on A');
            await waitForSaved(a.page, 'Written on A');

            // Device B: opens the same cloud workspace
            const b = await signedInDevice(String(user.id));
            devices.push(b);
            await api(b.page, 'POST', '/api/account/refresh');
            await api(
                b.page,
                'POST',
                `/api/workspaces/${workspaceId}/activate`,
            );
            expect(
                (
                    await api(
                        b.page,
                        'POST',
                        '/api/account/sync-active-workspace',
                    )
                ).body,
            ).toMatchObject({ synced: true });
            await b.page.reload();
            await openPage(b.page, 'Shared');
            await expect.poll(() => outline(b.page)).toEqual(['Written on A']);

            // B edits; A sees it without reloading
            await caretToEnd(b.page, 'Written on A');
            await b.page.keyboard.press('Enter');
            await b.page.keyboard.type('Written on B');
            await expect
                .poll(() => outline(a.page), { timeout: 20_000 })
                .toEqual(['Written on A', 'Written on B']);

            // B's cursor shows on A, labelled with the account name
            await expect(a.page.locator('.remote-caret')).toBeVisible({
                timeout: 20_000,
            });
            await expect(a.page.locator('.remote-caret-label')).toHaveText(
                'E2E',
            );
            await expectOnPage(a.page, 'Shared');
        } finally {
            if (workspaceId && devices[0]) {
                await api(
                    devices[0].page,
                    'DELETE',
                    `/api/workspaces/${workspaceId}`,
                ).catch(() => undefined);
            }

            for (const device of devices) {
                await device.app.close().catch(() => undefined);
                fs.rmSync(device.directory, { recursive: true, force: true });
            }
        }
    });
});
