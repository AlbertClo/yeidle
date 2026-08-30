# Desktop editor performance

## Large-page baseline

The `CCT todo` page in the `Albert Knowledge` workspace contains 1,395
descendant nodes. After the server-side tree-loading improvements, a local
development build spent approximately:

- 313 ms mounting the existing whole-page TipTap editor after the response;
- 218 ms mounting a virtualized block list after the response;
- 23 ms activating one TipTap editor for a visible block.

The existing editor produced roughly 3,889 live DOM elements. The virtualized
prototype produced roughly 280, including the active editor. The prototype
therefore reduced measured navigation time by about 27% and live DOM by about
93% in the development build.

The A/B test also showed that replacing TipTap without virtualization is not
enough: a non-virtualized static tree still took about 277 ms. Most remaining
work comes from materializing and laying out every block, rather than JSON
parsing or TipTap alone.

## Prototype

Progressive hydration is the default editor behavior in development and
production builds.

The virtualized block-editor experiments reduced the live DOM, but introduced
cursor handoff and variable-height scrolling problems. The current prototype
retains the established whole-page `PageEditor.vue`. It initially constructs a
40-node depth-first prefix for a normal page open, or a 40-node window around a
requested block when opening a search result or block reference. It lets that
content paint, then hydrates the same TipTap instance with the complete document
on the following animation frame.

The prototype:

- paints above-the-fold nodes before constructing the complete document;
- retains one TipTap instance and the established nested-list schema;
- restores whole-page selection, cursor, structural editing, and undo behavior;
- emits content and checkbox changes through the existing page sync pipeline.

## Behavioral parity required before rollout

- Render rich inactive content, including formatting, links, references,
  embeds, and media.
- Match Enter, Backspace, Tab, Shift+Tab, and multi-block paste semantics.
- Preserve vertical cursor navigation and focus when rows enter or leave the
  virtual window.
- Support multi-block selection and structural operations.
- Preserve whole-page undo expectations across content and structural edits.
- Apply remote content and structural changes without replacing the active
  editor under the cursor.
- Restore page-link, file, checkbox, slash-command, and media-menu behavior.
- Add component and end-to-end coverage before enabling the architecture by
  default.
