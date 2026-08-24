# Design canvases

Working sources for design explorations published as Claude Design canvases.
Each `*.dc.html` is one artboard; `canvas.json` places them on the canvas and
`_shared.css` is the wireframe vocabulary they share (PlanView's own tokens, so
the sketches read as this product rather than as generic wireframes).

The seeded `.html` a canvas publishes from is a ~2 MB editor payload with the
artboards embedded. It is generated, not authored, so it is gitignored — these
sources are the thing to edit, and reseeding produces it again.

## Canvases

| Sources | Canvas |
|---|---|
| `Today`, `OptionA`, `Main` (Option B), `OptionC`, `OptionD`, `canvas.json` | [PlanView Navigation](https://claude.ai/code/artifact/b19343dd-cc7d-46cb-bed9-810e8bf92a69) — four information architectures |

`Main.dc.html` holds the leading candidate, so it changes identity when a
direction is chosen: today it is Option B (Workspace).

## Rebuilding

The `/design` skill owns the seeding helper, and its base directory is
session-scoped — run `/design` to get the current path, then:

    node "<base>/seed-canvas.mjs" \
      --template "<base>/payload.template.html" \
      --out planview-navigation.html --title "PlanView Navigation" \
      --artboard Today.dc.html --artboard OptionA.dc.html --artboard Main.dc.html \
      --artboard OptionC.dc.html --artboard OptionD.dc.html \
      --canvas canvas.json

Then republish that file to the same artifact URL to keep the link stable.

If someone has edited the canvas in the browser since, read it back first
(`--extract`) so their changes are not overwritten.
