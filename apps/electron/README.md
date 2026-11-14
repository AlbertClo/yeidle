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

## Installing on NixOS

The repository is a flake (`flake.nix`, `nix/package.nix`). It builds the
app and runs it with nixpkgs' Electron, with a desktop entry and icon.

```bash
nix run github:AlbertClo/yeidle?ref=explore/loro   # try it
nix build .#yeidle                                 # build from a checkout
```

In a NixOS configuration:

```nix
# flake.nix inputs
yeidle.url = "github:AlbertClo/yeidle?ref=explore/loro";

# configuration
environment.systemPackages = [ inputs.yeidle.packages.${pkgs.system}.default ];
```

Update with `nix flake update yeidle` and a rebuild. After changing
`package-lock.json`, refresh `npmDepsHash` in `nix/package.nix` with
`nix run nixpkgs#prefetch-npm-deps -- package-lock.json`.

The installed app uses the same data directory as `npm start`
(`~/.config/yeidle`) and signs in to `YEIDLE_CLOUD_URL`
(default `http://localhost:8200`).

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

Workspaces live in `~/.config/yeidle` (Linux). On first launch the app
copies the NativePHP app's workspaces from `~/.config/yeidle-app` (the
NativePHP app's `APP_NAME` is "Yeidle App"; originals are never opened for
writing) and converts them to Loro documents.

Environment overrides, mostly for testing:

| Variable | Purpose |
| --- | --- |
| `YEIDLE_DATA_DIR` | Use another data directory |
| `YEIDLE_LEGACY_DIR` | Import NativePHP workspaces from another directory |
| `YEIDLE_SELF_CHECK=1` | Print what the window rendered (or the result of `YEIDLE_SELF_CHECK_SCRIPT`) and quit |
| `YEIDLE_SELF_CHECK_PATH` | Page to open for the self-check, e.g. `pages/<id>` |
| `YEIDLE_CLOUD_URL` | Yeidle Cloud to sign in to (default `http://localhost:8200`, the Sail app) |

## Cloud sync

Signing in uses the device flow: the app opens the cloud in the browser, you
approve the device, and the app stores the token in `cloud-account.json` in
its data directory. A synced workspace exchanges Loro updates with the cloud
relay (`packages/core/src/app/cloud/sync.ts`): local updates whose
`cloud_seq` is empty are pushed, other devices' updates are pulled after the
`sync_state.last_server_seq` cursor. Exchanges run shortly after local
changes, on a 15-second interval, and immediately when Reverb reports new
updates.

Media files travel separately from notes (`packages/core/src/app/cloud/blobs.ts`):
their metadata syncs in the Loro media document, the files go straight to
and from the cloud's object storage through presigned URLs. After each sync
the app uploads local files the cloud doesn't have and downloads files it's
missing; a file that's shown before it has arrived is downloaded on the spot.
Text never waits for file transfers.

Other windows' cursors on the same page show as colored carets with a name
(`src/renderer/src/presence/`). Each window keeps its selection as Loro
cursors in a Loro ephemeral store and sends the store's updates as client
events on a per-page Reverb presence channel; they go window to window and
are never stored.

An empty cloud workspace is seeded from the device that enables sync; a
device that opens it with an empty local copy downloads it. If both sides
already have notes, pairing is refused (the same notes converted on two
devices would merge into duplicates).

To try two devices on one machine, start Sail in `apps/web`, build once,
then run two instances with their own data directories:

```bash
npm run build -w @yeidle/electron
cd apps/electron
YEIDLE_DATA_DIR=/tmp/yeidle-a YEIDLE_LEGACY_DIR=/nonexistent npx electron-vite preview
YEIDLE_DATA_DIR=/tmp/yeidle-b YEIDLE_LEGACY_DIR=/nonexistent npx electron-vite preview
```

`YEIDLE_LEGACY_DIR=/nonexistent` skips copying the NativePHP workspaces.

## Not ported yet

- Streaming for large media files: transfers read and write whole files
  in memory.
- Page history.
- Other installable packages (AppImage, Windows, macOS, AUR) and
  auto-update; NixOS has the flake.
