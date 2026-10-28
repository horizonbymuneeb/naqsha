# How naqsha works

Four small stages, no dependencies, no network.

```
input.json ──validate──▶ IR ──layout──▶ scene ──compose──▶ output.html
```

## 1. Validate (`src/validate`)

A hand-rolled validator for our own IR v1. Every rejection returns
`{code, message, path, hint}` and the hint names the exact fix, because the
author here is an agent: a diagnostic it can act on turns a failed render into
a one-round repair. Unknown keys are rejected on purpose — a typo like
`subLabel` should fail loudly instead of silently losing a caption.

## 2. Layout (`src/layout`)

Deterministic geometry, no auto-layout magic:

- **architecture / workflow** — longest-path layering over the declared graph
  (cycles broken deterministically), barycenter pass to order nodes inside a
  layer, orthogonal channels between layers, and label boxes on free segments.
  A group becomes a rectangle around its members with a reserved label band.
- **sequence** — participants in one row, equally spaced lifelines, messages as
  two-point edges at rising y positions; a fragment is the tight box around the
  participants and messages it references.
- Box sizes come from a conservative text-metrics table (no font loading, so no
  measurement surprises between machines). The scene is plain JSON, which is why
  the whole pipeline is testable without a browser.

## 3. Compose (`src/view`)

One HTML string: inline SVG, inline CSS, inline JS, system font stack. The
viewer renders the scene, then adds reading affordances — hover focus with one-hop
dimming, zoom/pan, theme toggle, print stylesheet, keyboard focus — about 26 KB
of code and 17 KB of CSS. The default view fits the whole scene without
upscaling, so a wide diagram never gets cropped by the viewport.

## 4. Deliver (`src/cli`)

`render` writes to a temporary file in the destination directory and renames it
into place, so a failed render never leaves a half-written artifact. Receipts are
one JSON object on stdout; exit codes are 0/1/2, and a missing pipeline module
says `render pipeline not ready: <module>` instead of dumping a stack trace.

## Why not just render Mermaid

Mermaid optimizes for text-embedded diagrams. Here the artifact is the
deliverable: a file a person opens, reads, and shares. That requires owning the
geometry (so labels fit and groups enclose), the typography (so density is
readable) and the interactions (so a reader can trace a path). The cost is that
the input is a typed document, not a sketch — which is exactly what an agent can
write reliably.
