# Yeidle Desktop

A local-first note-taking desktop app built with NativePHP (Electron) + Laravel 12 + Vue 3 + SQLite.

## Requirements

- PHP 8.2+
- Composer
- Node.js 22+

## Setup

```bash
composer install
npm install
cp .env.example .env
php artisan key:generate
npm run build
php artisan native:install
php artisan native:migrate
```

## Development

```bash
composer run native:dev
```

This launches the NativePHP Electron app and the Laravel Vite development
server together. Changes under `resources/js` and `resources/css` are then
updated through Vite hot reload.

Running `php artisan native:run` by itself only watches the Electron process
and serves the most recently built frontend assets. Changes to the Electron
preload or main process still require restarting the development command.

## Architecture

- **Data model**: Everything is a node in a tree. Pages are top-level nodes (`parent_id = null`). Blocks are child nodes. Bookmarks are pages with a `url`.
- **Linking**: `[[wikilinks]]` in block content create bidirectional links between pages. Links are parsed on save and cached in the `node_links` table.
- **Frontend**: Local-first — the page tree lives in reactive Vue state. Edits are instant. A background sync layer persists changes to SQLite via the API (content edits debounced, structural changes immediate).
- **API**: JSON endpoints at `/api/` for nodes, pages, bookmarks, and search. Used by the frontend and the Chrome extension.

## SQLite

There are two SQLite databases:

- **`database/database.sqlite`** — the default Laravel database, used when running artisan commands directly (e.g. `php artisan migrate`).
- **`database/nativephp.sqlite`** — used by the app when running inside NativePHP (`php artisan native:run`). NativePHP manages its own database connection.

When developing, run `php artisan native:migrate` to apply migrations to the NativePHP database. To reset it, delete `database/nativephp.sqlite` and re-run `php artisan native:migrate`.

In production, NativePHP stores the database in the user's app data directory (e.g. `~/.config/nativephp/`).

## NixOS

Requires `nix-ld` with Electron libraries. See the project memory files for the full NixOS configuration.
