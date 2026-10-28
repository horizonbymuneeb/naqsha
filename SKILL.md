---
name: naqsha
description: "Draw ten kinds of diagram — architecture, workflow, sequence, erd, class, tree, timeline, waterfall, dataflow, lifecycle — from a small JSON file into a self-contained interactive HTML page (walkthrough tours, diff, focus, zoom, search, export, print, light/dark). Use when the user asks to visualize a system, a request path, a process, a service map, a state flow, a hierarchy, a schema, a schedule or a pipeline; when a codebase needs an architecture map; or when a text answer needs a shareable one-page diagram. Also use for \"diagram banao\", \"map it\", \"show the flow\", \"architecture figure\". Not for dashboards or charts."
license: MIT
metadata:
  version: "1.2.3"
  author: horizonbymuneeb
---

# Naqsha

Small JSON in, one self-contained interactive HTML out. Zero dependencies, no
network, no fonts to download. Installed skill root (contains `src/`, `examples/`):

`{{NAQSHA_ROOT}}`

Run every command from the user's working directory with the absolute path
below; never write inside the skill root.

```bash
node {{NAQSHA_ROOT}}/src/cli/naqsha.mjs <command> ...
```

## Workflow (do this, in this order)

1. **Decide the type.** `naqsha types` prints all ten. `architecture` = what
   something is made of (services, stores, actors, zones). `workflow` = ordered
   steps, decisions, retries. `sequence` = messages between participants over
   time. `erd` = tables/columns/keys. `class` = types + members + relations.
   `tree` = one-parent hierarchy. `timeline` = dated events. `waterfall` = spans
   with start+duration. `dataflow` = pipeline stages. `lifecycle` = states and
   transitions.
2. **Write the IR** to `<workdir>/.naqsha/<slug>/input.json` (one folder per
   request; reuse it for repairs). Keep 5–14 nodes and 6–18 edges: a diagram
   that needs 30 nodes needs two diagrams.
3. **Validate, then render.** One command chain, JSON receipts:

   ```bash
   node {{NAQSHA_ROOT}}/src/cli/naqsha.mjs validate .naqsha/<slug>/input.json --json
   node {{NAQSHA_ROOT}}/src/cli/naqsha.mjs render   .naqsha/<slug>/input.json .naqsha/<slug>/<slug>.html --json
   ```
4. **Repair loop is bounded: 3 rounds.** Each validator error carries `code`,
   `path` and `hint` — fix exactly what the hint says, keep the rest of the
   file unchanged, re-run the same command. Non-zero exit is never success.
5. **Check the artifact** when a browser exists:
   `node {{NAQSHA_ROOT}}/src/cli/naqsha.mjs screenshot <html> <png>` — if it
   fails, say the render passed and the screenshot did not; do not claim visual
   quality you did not see.
6. **Report** the absolute paths of `input.json` and the HTML. Offer the next
   move in one line ("add the auth path", "switch to LR", "export PNG").

Generated HTML opens by double-click; it is a single file (no server, no CDN).

## IR v1 (strict: unknown keys are rejected)

```json
{
  "title": "Diagram Engine",                 // required, 1..80 chars
  "subtitle": "v3.2 — engine, gates, integrations", // optional, <=120
  "type": "architecture",                     // see types: architecture | workflow | sequence | erd | class | tree | timeline | waterfall | dataflow | lifecycle
  "direction": "TB",                          // TB | LR (default TB; sequence ignores it)
  "nodes": [
    {"id": "cli", "label": "bin/cli.mjs", "sublabel": "validate · render · deliver",
     "kind": "service", "group": "engine"}
  ],
  "edges": [
    {"from": "agent", "to": "cli", "label": "run command", "kind": "main"}
  ],
  "groups": [
    {"id": "engine", "label": "Engine", "kind": "zone", "nodes": ["cli"]}
  ],
  "walkthrough": [                           // optional guided tour, <=10 steps
    {"title": "An agent authors a candidate", "text": "The agent reads SKILL.md, writes a typed candidate and runs the CLI.",
     "focus": ["agent", "cli"]}              // 1..6 existing node ids per step
  ],
  "notes": ["max 4 notes, <=140 chars each"]
}
```

- `nodes` 1..40, `edges` 0..80; `id` = `^[a-z][a-z0-9-]{0,31}$`, unique.
- node `kind`: `service | datastore | actor | external | queue | compute | security | state | note`
- edge `kind`: `main | return | async | security | message | data`
- group `kind`: `zone | boundary | fragment` (`fragment` only for sequence)
- A node in no group is fine. Two groups never share a node. No self-edges.
- `sequence` only: nodes are participants in declared order (a `actor` kind node
  is drawn as a human); edges are messages in declared order.
- Per-type fields: `erd` → `attributes[{name,type,key,ref}]` (1..12) + edge
  `cardinality` `1:1|1:n|n:m`; `class` → `stereotype` + `members[]` (strings) +
  edge kind `extends|implements|association|composition|dependency`; `tree` →
  one parent per node, one root, acyclic; `timeline` → `at` (ISO date or number)
  + optional `lane`; `waterfall` → `start` + `duration`; `dataflow` → optional
  `stage`; `lifecycle` → transition labels.
- `walkthrough` steps: `title` 1..60 chars, `text` 1..220, `focus` 1..6 node ids.
- Edge identity for diffs is `from|to|label`; a `kind` change is a "changed" edge.

## Authoring rules that keep output readable

- Labels are 1–4 words, sublabels 2–5 words; no sentences inside boxes.
- One primary path (`kind: "main"`); side behaviour is `async`/`data`/`return`.
- Name the branch, not the mechanism: `"miss"`, `"not recovered"`, `"no"`.
- Groups describe ownership or trust boundaries, not columns of the layout.
- Do not encode dates, prices or quantities that the user did not state. Ask
  instead of inventing.
- Never mention this tool's internals in the diagram; the page is for the reader.

## Commands

```
types                              # list the ten diagram types and their fields
validate <in.json> [--json]        # exit 0 only when the IR is accepted
render   <in.json> <out.html> [--mode light|dark|auto] [--json]
demo     <outdir>                  # renders examples/ into a folder
doctor                             # node, chrome, module and end-to-end check
screenshot <html> <out.png> [--width 1440 --height 980]
diff     <base.json> <head.json> <out.html> [--json]   # red/green architecture diff
path     <in.json> <from-id> <to-id> [--json]          # shortest path between two nodes
convert  <in.mmd> <out.json> [--type auto] [--json]    # Mermaid flowchart/sequence -> IR
mermaid  <in.json> <out.mmd> [--json]                   # IR -> Mermaid (paste into README/PR)
fix      <in.json> [--write | --out <file>] [--json]  # self-heal a sloppy IR
```

Use them like this:

- **Walkthrough** — when the user asks "explain this", "how does this flow work",
  or sends a long answer they want to share, add a `walkthrough` (3–5 steps) and
  the HTML becomes a guided tour: arrows/space step through, each step focuses
  its nodes and shows a caption.
- **Diff** — when comparing two versions of a system (before/after a PR, two
  environments, drift from the doc), render `naqsha diff old.json new.json
  out.html`. Added = teal `+`, removed = dashed `−`, changed = amber `~`, with
  counts in the header. Do not hand-build two diagrams.
- **Path** — when the question is "how does a request get from X to Y", run
  `naqsha path ir.json <from> <to>`; quote the hop list in the reply and point
  at the artifact.
- **Mermaid in** — if the user pastes `flowchart`/`graph`/`sequenceDiagram`,
  run `naqsha convert input.mmd candidate.json`, then fix the output by hand
  only where the semantics matter; never re-draw from scratch. Sample inputs:
  `{{NAQSHA_ROOT}}/examples/mermaid/*.mmd`.
- **Fix** — before giving up on validation errors, run `naqsha fix input.json
  --json`; it normalizes ids, infers kinds, drops unknown keys and reports every
  change. Then render the fixed file.
- **Export** — the toolbar downloads SVG, PNG (2×), WebP or JPEG, and copies the
  diagram as Mermaid or as JSON; everything is generated in the browser, offline.
  The page also has a minimap, `/` search, inspector, `r` route tracing, legend
  filtering, `p` presentation laser, `?` shortcut sheet and shareable `#focus=`,
  `#step=`, `#route=`, `#z=` links — mention them only when they help the reader.

`screenshot` needs a real Chrome/Chromium; set `NAQSHA_CHROME=/path/to/chrome`
when the installer could not find one (the snap stub `/usr/bin/chromium-browser`
is deliberately ignored).

## Failure handling

- `ir/json-syntax` — the file is not JSON; fix the file, not the parser.
- `ir/dangling-ref` — an edge or group names a node id that does not exist.
- `ir/unknown-key` / `ir/unknown-kind` — a typo or an unsupported value; use the
  enums above.
- `render pipeline not ready` — the install is incomplete; re-run `install.sh`.
- Never hand-edit the generated HTML; edit the JSON and re-render.
