# Roam Research import

Yeidle imports a Roam Research JSON export into a workspace, as Loro page
documents. The import is resumable: page, block, and media identifiers are
deterministic, so running the same export again doesn't duplicate anything.

## Importing

Open the workspace menu, choose **Import**, then **Roam Research**. Select the
JSON export and a destination:

- **Create a new workspace** (the safer default): the workspace stays inactive
  until the import finishes, then opens from the summary. If the import fails
  or you stop it, the incomplete workspace is removed.
- **An existing workspace**: the Roam pages are merged into its current
  content. Stopping part-way keeps what was already written; run the same
  import again to finish.

The dialog uploads the export in 1 MB chunks, shows progress, and ends with a
summary: pages and blocks, references, embeds, attachments, unsupported
macros, unresolved references, and any warnings.

The importer lives in `packages/core/src/app/import/roam/`; its HTTP side is
`packages/core/src/app/controllers/roamImport.ts`.

## File uploads

With **Import file uploads** ticked (the default), Roam-hosted images, videos,
PDFs and other files are downloaded into the workspace's content-addressed
media store and become file blocks; they then sync like any other media.
Ordinary external links are never downloaded. Untick it to keep Roam uploads
as links.

If a download fails, its original URL is kept, a warning names it, and the
summary reports the failure. Run the same import again to retry: completed
blocks and files are reused.

## Converted features

- Pages, nested blocks, and sibling order
- Page references (`[[Page]]`)
- Block references (`((uid))`)
- Block embeds (`{{[[embed]]: ((uid))}}`)
- TODO and DONE checkboxes
- Headings
- Roam-hosted images, videos, PDFs, and other files
- Markdown and plain HTTP links

Unknown Roam macros stay readable as plain text and are counted in the
summary. Identifiers are namespaced by workspace, so importing the same
export into two workspaces can't collide.
