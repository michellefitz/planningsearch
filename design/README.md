# Design canvases

Working sources for design explorations published as Claude Design canvases.
One folder per canvas: each `*.dc.html` is an artboard, `canvas.json` places
them, and the `_*.css` beside them is the wireframe vocabulary they share —
PlanView's own tokens, lifted from `web/src/styles.css`, so the sketches read
as this product rather than as generic mockups.

The seeded `.html` a canvas publishes from is a ~2 MB editor payload with the
artboards embedded. It is generated, not authored, so it is gitignored — these
sources are the thing to edit, and reseeding produces it again.

## Canvases

### `navigation/` — [PlanView Navigation](https://claude.ai/code/artifact/b19343dd-cc7d-46cb-bed9-810e8bf92a69)

Four information architectures for the whole product. Option B (Workspace) was
chosen and is built; see #99. `Main.dc.html` holds it, with the alternatives
kept on a second page for the reasoning.

### `chat-cards/` — [Agent Property Cards](https://claude.ai/code/artifact/9cdc2a2a-2c46-44b2-a1e1-4c2b6d03b07a)

Three ways to stop the card the Ask agent renders under every property from
repeating the paragraph above it. `Main.dc.html` holds the leading candidate
(Option A, Citation). Undecided.

Two causes, two different fixes, which is why the options split where they do:

- **Visual** — `.chat-app-card` extends `.result-card`, the search-results list
  row. That is borderless by design because the list has dividers; in a grey
  chat bubble it has none, so it reads as a paragraph.
- **Content** — `server/src/agent/prompt.ts` tells the model to bold the
  address before emitting the token, so the address, the status and the
  proposal are each said twice. Fixing that is a prompt change, not a
  renderer change.

`Main.dc.html` is the leading candidate in each folder, so it changes identity
when a direction is chosen.

## Rebuilding

The `/design` skill owns the seeding helper and its base directory is
session-scoped — run `/design` for the current path, then from the canvas
folder:

    node "<base>/seed-canvas.mjs" \
      --template "<base>/payload.template.html" \
      --out <name>.html --title "<Name>" \
      --artboard Main.dc.html --artboard ... \
      --canvas canvas.json

Republish that file to the same artifact URL to keep the link stable. If anyone
has edited the canvas in the browser since, read it back first (`--extract`) so
their changes are not overwritten.
