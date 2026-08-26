import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestCloudExchangeMock } = vi.hoisted(() => ({
    requestCloudExchangeMock: vi.fn().mockResolvedValue(true),
}));

vi.mock('../sync/cloud', () => ({
    requestCloudExchange: requestCloudExchangeMock,
}));

import {
    fontFamilyPreference,
    fontSizePreference,
    loadPreferences,
    opsAffectPreferences,
    preferenceRootId,
    saveThemePreference,
    saveTypographyPreference,
    themePreference,
} from './preferences';

describe('preferences store', () => {
    beforeEach(() => {
        themePreference.value = 'dark';
        fontFamilyPreference.value = 'instrument-sans';
        fontSizePreference.value = 16;
        preferenceRootId.value = '00000000-0000-7000-8000-000000000099';
        requestCloudExchangeMock.mockClear();
        vi.restoreAllMocks();
    });

    it('uses Light when a workspace has no saved theme', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: preferenceRootId.value,
                    theme: null,
                }),
                { status: 200 },
            ),
        );

        await loadPreferences(true);

        expect(themePreference.value).toBe('light');
        expect(fontFamilyPreference.value).toBe('instrument-sans');
        expect(fontSizePreference.value).toBe(16);
    });

    it('persists the selected theme and requests a cloud exchange', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: preferenceRootId.value,
                    theme: 'light',
                }),
                { status: 200 },
            ),
        );

        await saveThemePreference('light');

        expect(themePreference.value).toBe('light');
        expect(fetchMock).toHaveBeenCalledWith('/api/preferences/theme', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ theme: 'light' }),
        });
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('persists a named theme', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: preferenceRootId.value,
                    theme: 'catppuccin-mocha',
                }),
                { status: 200 },
            ),
        );

        await saveThemePreference('catppuccin-mocha');

        expect(themePreference.value).toBe('catppuccin-mocha');
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/preferences/theme',
            expect.objectContaining({
                body: JSON.stringify({ theme: 'catppuccin-mocha' }),
            }),
        );
    });

    it('persists font family and size and requests a cloud exchange', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    root_id: preferenceRootId.value,
                    theme: 'light',
                    font_family: 'jetbrains-mono',
                    font_size: 18,
                }),
                { status: 200 },
            ),
        );

        await saveTypographyPreference('jetbrains-mono', 18);

        expect(fontFamilyPreference.value).toBe('jetbrains-mono');
        expect(fontSizePreference.value).toBe(18);
        expect(fetchMock).toHaveBeenCalledWith('/api/preferences/typography', {
            method: 'PUT',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                font_family: 'jetbrains-mono',
                font_size: 18,
            }),
        });
        expect(requestCloudExchangeMock).toHaveBeenCalledOnce();
    });

    it('refreshes only for the active user preference root', () => {
        expect(
            opsAffectPreferences([
                {
                    payload: {
                        id: 'theme-entry',
                        page_id: preferenceRootId.value,
                    },
                },
            ]),
        ).toBe(true);
        expect(
            opsAffectPreferences([
                {
                    payload: {
                        id: 'another-users-theme-entry',
                        page_id: 'another-users-root',
                    },
                },
            ]),
        ).toBe(false);
    });
});
