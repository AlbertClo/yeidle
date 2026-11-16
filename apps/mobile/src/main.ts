import {
    coreReady,
    installCoreFetch,
    installMediaUrls,
    installNative,
} from './core/bridge';

/**
 * Yeidle on Android: the desktop renderer, running in the WebView against
 * the core worker. The first page comes from the core as Inertia JSON (the
 * desktop app gets it embedded in the HTML), then the renderer starts.
 */

installCoreFetch();
installNative();
installMediaUrls();

async function start(): Promise<void> {
    await coreReady;

    const response = await fetch(
        `${window.location.pathname}${window.location.search}`,
        {
            headers: {
                'X-Inertia': 'true',
                Accept: 'text/html, application/xhtml+xml',
            },
        },
    );
    const page = await response.json();
    document.getElementById('app')!.dataset.page = JSON.stringify(page);

    await import('@/app');
}

start().catch((error: unknown) => {
    document.body.textContent = `Yeidle couldn't start: ${
        error instanceof Error ? error.message : String(error)
    }`;
});
