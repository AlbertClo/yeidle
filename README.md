# Yeidle

A local-first note-taking app in the outliner style of Roam and Logseq:
pages of nested blocks, `[[links]]` and backlinks, daily notes, block
references, and files. Notes live on your device; signing in to Yeidle Cloud
syncs them between devices, with live cursors when two windows edit the same
page.

Content is stored as [Loro](https://loro.dev) CRDT documents, one per page, so
edits made on different devices, including offline, merge without conflicts.
The design is in [docs/loro-architecture.md](docs/loro-architecture.md).

## Repository

| Path | What it is |
| --- | --- |
| [`apps/electron`](apps/electron) | **The desktop app.** Electron shell and the Vue/TipTap UI. Start here. |
| [`packages/core`](packages/core) | `@yeidle/core`: the app's backend in TypeScript (workspaces, Loro documents, SQLite read model, search, cloud sync, Roam import). Platform-neutral, so a future Android app can share it. |
| [`apps/web`](apps/web) | **Yeidle Cloud.** Laravel app: accounts, device sign-in, workspaces, the Loro update relay, file storage, and Reverb for realtime. |
| [`docs`](docs) | Design notes. |
| [`flake.nix`](flake.nix) | Nix flake; the desktop app's package is [`apps/electron/package.nix`](apps/electron/package.nix). |

`apps/electron` and `packages/core` form an npm workspace (the root
`package.json`) with one lock file. `apps/web` is a separate project with its
own dependencies.

## Running the desktop app

Requires Node 22+.

```bash
npm install
npm run dev     # hot reload
npm start       # build, then run the built app
npm test        # core and renderer tests
```

Running from the checkout keeps its data in `~/.config/yeidle-dev`; the
installed app uses `~/.config/yeidle`. See the
[desktop app's README](apps/electron/README.md) for how it fits together,
environment overrides (separate data folders, which cloud to use), and how to
run two instances to try sync.

### Installing on NixOS

```bash
nix run github:AlbertClo/yeidle?ref=explore/loro
```

Or add the flake to your system configuration; see
[Installing on NixOS](apps/electron/README.md#installing-on-nixos).
Installers for other platforms (AppImage, Windows, macOS, AUR) and
auto-update aren't built yet.

## Running the cloud

`apps/web` runs on [Laravel Sail](https://laravel.com/docs/sail) (Docker),
with Postgres, Redis, Reverb, a queue worker, and S3-compatible storage
(rustfs) for files. The first `composer install` needs PHP 8.3+ on the
host; after that everything runs in the containers.

```bash
cd apps/web
cp .env.example .env
composer install
./vendor/bin/sail up -d
./vendor/bin/sail artisan key:generate
./vendor/bin/sail artisan migrate
./vendor/bin/sail artisan blobs:ensure-bucket
./vendor/bin/sail artisan test --compact
```

The cloud is served at <http://localhost:8200>, which is where the desktop app
signs in by default (`YEIDLE_CLOUD_URL` overrides it). Register an account
there, then choose "Sign in" in the desktop app and approve the device in the
browser.

## Documentation

- [docs/loro-architecture.md](docs/loro-architecture.md): the current
  architecture (Loro documents, the shared core, cloud relay, phases).
- [apps/electron/README.md](apps/electron/README.md): the desktop app, cloud
  sync, live cursors, and Nix packaging.
- [docs/roam-import.md](docs/roam-import.md): importing a Roam Research
  export.
- [docs/editor-performance.md](docs/editor-performance.md): editor
  performance measurements on large pages.
