# Yeidle (Electron)

The desktop app: Electron with the shared TypeScript core in
[`packages/core`](../../packages/core). Architecture:
[docs/loro-architecture.md](../../docs/loro-architecture.md).

## Running

From the repository root:

```bash
npm install
npm start      # build and run
npm run dev    # run with hot reload
npm test       # core and renderer tests
npm run test:e2e   # end-to-end tests: builds, then drives the real app
```

## Installing on NixOS

The repository is a flake (`flake.nix`, with the package in `apps/electron/package.nix`). It builds the
app and runs it with nixpkgs' Electron, with a desktop entry and icon.

```bash
nix run github:AlbertClo/yeidle   # try it
nix build .#yeidle                                 # build from a checkout
```

In a NixOS configuration:

```nix
# flake.nix inputs
yeidle.url = "github:AlbertClo/yeidle";

# configuration
environment.systemPackages = [ inputs.yeidle.packages.${pkgs.system}.default ];
```

Update with `nix flake update yeidle` and a rebuild.

To install from a checkout into your user profile, or update that install,
run from the repository root:

```bash
npm run install:desktop
```

It builds the app (fixing `npmDepsHash` when `package-lock.json` changed),
installs it with `nix profile`, or upgrades the copy installed from this
checkout, and links the desktop entry into `~/.local/share/applications` so
the app shows in the menu. Files git doesn't track yet aren't part of the
build. Restart the app afterwards.

After changing
`package-lock.json`, refresh `npmDepsHash` in `apps/electron/package.nix` with
`nix run nixpkgs#prefetch-npm-deps -- package-lock.json`.

The installed app keeps its data in `~/.config/yeidle` and signs in to
`YEIDLE_CLOUD_URL` (default `http://localhost:8200`).

## End-to-end tests

`e2e/` holds Playwright tests that drive the built app through Playwright's
Electron support. Each test starts the app on a fresh data folder, past
first-launch setup (theme, local storage, continue offline), and works the
way a user does: keyboard, visible text and roles, not implementation
details. That's what makes them useful when refactoring.

- `e2e/fixtures.ts`: the app fixture (`page`, `restart()` to relaunch on the
  same data) and helpers such as `createPage`, `openPage`, `outline` (the
  page's blocks as an indented list) and `waitForSaved`.
- Specs: `editing`, `keyboard` (moving blocks, arrows, files, the link
  popover), `links`, `navigation` (All Pages, search, back/forward, daily
  notes, pins), `pages` (collapsing, daily-note stepping, renaming),
  `roam-import`, and `cloud-sync`.
- `cloud-sync.spec.ts` runs two app instances against a real cloud and is
  skipped unless `YEIDLE_E2E_CLOUD_URL` and `YEIDLE_E2E_CLOUD_TOKEN` are set
  (see the file for the command).
- Known issues are kept as `test.fixme` tests: they're skipped until fixed,
  then flipped to `test`.
- Test windows emulate focus, so tests behave the same while you use other
  apps or run several at once.
- Run one file or test: `npx playwright test e2e/links.spec.ts -g backlink`.
- Failures keep a trace and a screenshot in `test-results/`; open a trace
  with `npx playwright show-trace <path>/trace.zip`.

## How it fits together

- **Main process** (`src/main`): serves the app on `yeidle://app`. Requests
  for `/api/*` and the page routes go to the core's app server
  (`packages/core/src/app/server.ts`), which answers with JSON or the
  Inertia page protocol, the same contract the Laravel app had. Everything
  else is renderer assets (built files, or the Vite dev server).
- **Renderer** (`src/renderer`): the Vue/Inertia frontend. Each open page edits a live Loro document
  (`src/renderer/src/sync/documentSession.ts`) and sends updates to the main
  process, which stores them, refreshes the SQLite read model, and tells
  every window which documents changed.
- **Preload** (`src/preload`): `window.Native`, the window-control API, plus
  document change events.

## Data

Workspaces live in `~/.config/yeidle` (Linux) for the installed app, and in
`~/.config/yeidle-dev` when it runs from this checkout (`npm run dev`,
`npm start`), so development never shares databases with your notes and a
schema change doesn't reach them before you upgrade the installed app. (It
detects the checkout by `electron.vite.config.ts` next to the app.) To test
against a fresh copy of your notes, refill `yeidle-dev` from `yeidle` with
`sqlite3 <db> ".backup <copy>"` for each workspace database.

The workspace database's layout is in
[docs/database-design.md](../../docs/database-design.md). Until launch there
are no migrations: a workspace database from an older schema is renamed to
`<name>.sqlite.old` and replaced with an empty one; re-import your notes.

Environment overrides, mostly for testing:

| Variable | Purpose |
| --- | --- |
| `YEIDLE_DATA_DIR` | Use another data directory |
| `YEIDLE_SELF_CHECK=1` | Print what the window rendered (or the result of `YEIDLE_SELF_CHECK_SCRIPT`) and quit |
| `YEIDLE_SELF_CHECK_PATH` | Page to open for the self-check, e.g. `pages/<id>` |
| `YEIDLE_CLOUD_URL` | Yeidle Cloud to sign in to (default `http://localhost:8200`, the Sail app) |

## Cloud sync

Signing in uses the device flow: the app opens the cloud in the browser, you
approve the device, and the app stores the token in `cloud-account.json` in
its data directory. A synced workspace exchanges Loro updates with the cloud
relay (`packages/core/src/app/cloud/sync.ts`): local updates whose
`cloud_seq` is empty are pushed, other devices' updates are pulled after the
cloud cursor kept in the workspace's `meta` table. Exchanges run shortly after local
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
YEIDLE_DATA_DIR=/tmp/yeidle-a npx electron-vite preview
YEIDLE_DATA_DIR=/tmp/yeidle-b npx electron-vite preview
```

## Not ported yet

- Streaming for large media files: transfers read and write whole files
  in memory.
- Page history.
- Other installable packages (AppImage, Windows, macOS, AUR) and
  auto-update; NixOS has the flake.
