# Yeidle for Android (prototype)

A Capacitor app that runs the same TypeScript core as the desktop app,
[`packages/core`](../../packages/core), inside the phone's WebView.

What it does so far: sign in to Yeidle Cloud, download a workspace, list and
search its pages, and read a page. No editing yet.

## How it fits together

- **The core runs in a Web Worker** (`src/core/worker.ts`), the counterpart
  of Electron's main process. It owns the workspace databases and cloud
  sync, and answers the UI through the same app server and JSON API the
  desktop windows use (`src/core/client.ts`, `api('GET', '/api/pages')`).
- **SQLite** is the official WebAssembly build with the `opfs-sahpool`
  storage pool (`src/core/sqlite.ts`). It keeps files in the WebView's
  origin-private file system and gives the core the synchronous database it
  expects, which only works inside a worker.
- **Files** (workspace index, account, settings, media) are rows in a SQLite
  table (`src/core/files.ts`), since a worker has no synchronous file system.
- **`node:crypto`**, the core's only Node built-in on this path, is replaced
  with a small SHA-256 shim (`src/shims/nodeCrypto.ts`).
- Sign-in opens the approval page with Capacitor's Browser plugin and checks
  for approval every 3 seconds.

The app signs in to `https://app.yeidle.com`; the browser build can use a
local cloud with `VITE_YEIDLE_CLOUD_URL=http://localhost:8200`.

## Running

In a browser (Chromium), from the repository root:

```bash
npm run dev -w @yeidle/mobile      # http://localhost:5180
```

On Android, build the debug APK in the flake's Android shell (Java 21 and
the Android SDK; the first run downloads Gradle and its plugins):

```bash
nix develop .#android
npm run android:apk -w @yeidle/mobile
# apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Install it with `adb install -r <apk>` (USB debugging on), or copy the APK to
the phone and open it.

Or run it in an emulator, from the repository root after building the APK:

```bash
nix run .#android-emulator
```

That boots an Android 16 virtual phone (KVM-accelerated; kept in
`~/.local/share/yeidle-android` between runs), installs the APK and opens
Yeidle. The Android tooling lives in `android.nix`.

On Android the app talks to `https://app.yeidle.com`. A local Sail cloud
(plain HTTP) is blocked there: the app runs from `https://localhost`, so
HTTP requests count as mixed content. Use the browser build for local-cloud
work.

## Not done yet

- Editing, daily notes and quick capture
- Media (files are stored, but not shown)
- Realtime updates (the core still syncs every 15 seconds while the app is open)
- Moving a workspace database aside on a schema change (needs a rename the
  storage pool doesn't have)
