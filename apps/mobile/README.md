# Yeidle for Android

The desktop app's interface, [`apps/electron/src/renderer`](../electron/src/renderer),
running in the phone's WebView against the same TypeScript core,
[`packages/core`](../../packages/core). Same editor, pages, search, themes
and fonts; on phone widths the sidebar is a drawer and an editing toolbar
(indent, outdent, move, checkbox, undo, redo) sits above the keyboard.

## How it fits together

- **The renderer is built from the desktop sources** (`vite.config.ts`
  aliases `@` to them and uses the same Vue and Tailwind setup), started by
  `src/main.ts`, which loads the first page from the core as Inertia JSON.
- **The core runs in a Web Worker** (`src/core/worker.ts`), the counterpart
  of Electron's main process: it owns the workspace databases and cloud
  sync, and answers the renderer through the same app server.
- **`src/core/bridge.ts` stands in for Electron:** it routes the renderer's
  fetches for app URLs (`/api/*`, Inertia pages) to the worker, provides
  `window.Native` (document change events; no window controls), and loads
  `/api/media/*` images and videos through the core as blob URLs.
- **SQLite** is the official WebAssembly build with the `opfs-sahpool`
  storage pool (`src/core/sqlite.ts`). It keeps files in the WebView's
  origin-private file system and gives the core the synchronous database it
  expects, which only works inside a worker.
- **Files** (workspace index, account, settings, media) are rows in a SQLite
  table (`src/core/files.ts`), since a worker has no synchronous file system.
- **`node:crypto`**, the core's only Node built-in on this path, is replaced
  with a small SHA-256 shim (`src/shims/nodeCrypto.ts`).
- Sign-in opens the approval page with Capacitor's Browser plugin and closes
  it once the device is approved.

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

- Android's back gesture going back a page
- Hiding keyboard-shortcut hints on phones
- Opening a file in another app, or its folder
- Not tried on a phone yet: live updates and cursors over Reverb, images,
  Roam import
- Moving a workspace database aside on a schema change (needs a rename the
  storage pool doesn't have)
