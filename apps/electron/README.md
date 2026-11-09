# Yeidle (Electron)

The new desktop app: Electron with the shared TypeScript core in
[`packages/core`](../../packages/core). It replaces the NativePHP app in
[`apps/desktop`](../desktop), which stays in the repository, unchanged, as a
reference. Architecture: [docs/loro-architecture.md](../../docs/loro-architecture.md).

## Running

From the repository root:

```bash
npm install
npm start      # build and run
npm run dev    # run with hot reload
npm test       # core and renderer tests
```

## How it fits together

- **Main process** (`src/main`): serves the app on `yeidle://app`. Requests
  for `/api/*` and the page routes go to the core's app server
  (`packages/core/src/app/server.ts`), which answers with JSON or the
  Inertia page protocol, the same contract the Laravel app had. Everything
  else is renderer assets (built files, or the Vite dev server).
- **Renderer** (`src/renderer`): the Vue/Inertia frontend from the NativePHP
  app. Each open page edits a live Loro document
  (`src/renderer/src/sync/documentSession.ts`) and sends updates to the main
  process, which stores them, refreshes the SQLite read model, and tells
  every window which documents changed.
- **Preload** (`src/preload`): `window.Native`, the same window-control API
  the NativePHP build exposed, plus document change events.

## Data

Workspaces live in `~/.config/yeidle-app` (Linux). On first launch the app
copies the NativePHP app's workspaces from `~/.config/yeidle` (originals are
never opened for writing) and converts them to Loro documents.

Environment overrides, mostly for testing:

| Variable | Purpose |
| --- | --- |
| `YEIDLE_DATA_DIR` | Use another data directory |
| `YEIDLE_LEGACY_DIR` | Import NativePHP workspaces from another directory |
| `YEIDLE_SELF_CHECK=1` | Print what the window rendered (or the result of `YEIDLE_SELF_CHECK_SCRIPT`) and quit |
| `YEIDLE_SELF_CHECK_PATH` | Page to open for the self-check, e.g. `pages/<id>` |

## Not ported yet

- Yeidle Cloud (sign-in, sync, realtime). The routes answer as if no cloud
  is configured.
- Installable packages (electron-builder).
