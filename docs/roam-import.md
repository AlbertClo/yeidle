# Roam Research import

Yeidle can import a Roam Research JSON export into the desktop app's local,
syncable node log. The import is resumable: page, block, and media identifiers
are deterministic, and repeating an unchanged import does not duplicate data.

## Before importing

Open the workspace menu in the desktop app and choose **Import Roam
database**. Select the JSON export, then either create a new workspace or
explicitly choose an existing workspace. A new workspace is the safer default;
importing into an existing workspace merges the Roam pages with its current
content. File uploads are downloaded by default and can be disabled in the
dialog.

The dialog uploads large exports in 1 MB chunks, keeps the destination
inactive until the import finishes, and shows a summary and any warnings before
opening it.

For command-line validation, back up the Yeidle desktop data and run a dry run
first:

```bash
cd apps/desktop
php artisan roam:import /path/to/roam-export.json --dry-run
```

The report shows page and block totals, references, embeds, attachments,
unsupported macros, and unresolved references. A dry run neither downloads
files nor writes to SQLite.

## Import into a separate workspace

Stop the desktop app, then run:

```bash
php artisan roam:import /path/to/roam-export.json \
    --new-workspace="Albert Knowledge"
```

In a development checkout, the command automatically targets NativePHP's
workspace index rather than Laravel's ordinary `database.sqlite`. It creates a
separate migrated SQLite database and media directory, makes it active, and
imports into it. The existing Personal workspace is not changed. Start the
desktop app again after the command finishes.

To resume an interrupted import, pass the workspace ID reported by the command
instead of creating another workspace:

```bash
php artisan roam:import /path/to/roam-export.json \
    --workspace=019c0000-0000-7000-8000-000000000000
```

Running the same export again in the same workspace is idempotent. Imported
identifiers are namespaced by workspace, so importing the export into a
different workspace cannot collide with the first import in cloud storage.

Roam Firebase uploads are downloaded into Yeidle's content-addressed media
store and become native file nodes. Their metadata and blobs then use the
normal cloud sync outbox. Ordinary external links are never downloaded. To
leave Roam uploads as links, pass `--without-files`.

If a download fails, its original URL is preserved and the command exits with
a failure status. Fix the problem and run the same import again; completed
nodes and attachments are reused.

## Converted features

- Pages, nested blocks, and sibling order
- Page references (`[[Page]]`)
- Block references (`((uid))`)
- Block embeds (`{{[[embed]]: ((uid))}}`)
- TODO and DONE checkboxes
- Headings
- Roam-hosted images, videos, PDFs, and other files
- Markdown and plain HTTP links

Unknown Roam macros remain readable as plain text and are counted in the
report. The source export is never copied into the repository.
