# Naqsha — interface contract v1 (read before writing code)

Naqsha is our own free, zero-dependency diagram skill for **every** coding agent:
one small JSON file in → one self-contained interactive HTML out. Own schema,
own layout engine, own design system, own brand. No npm dependencies, Node >= 18,
ESM, aarch64 Linux friendly.

Prior art was studied at the behaviour level only — no source, template,
asset or stylesheet is vendored, called or linked from this repository — we do not call it, link it,
vendor it, or copy its template/assets.

## Pipeline

```
input.json --validate--> IR --layout--> scene --compose--> output.html
```

## 1. IR v1 (author-facing JSON, our schema)

```json
{
  "title": "Checkout service map",          // required, 1..80 chars
  "subtitle": "production, 2026-10",         // optional, <=120
  "type": "architecture",                    // required: architecture | workflow | sequence
  "direction": "TB",                         // optional: TB | LR (default TB; ignored by sequence)
  "nodes": [
    {"id": "web", "label": "Web App", "sublabel": "React, edge-cached",
     "kind": "service", "group": "edge"}
  ],
  "edges": [
    {"from": "web", "to": "api", "label": "GET /cart", "kind": "main"}
  ],
  "groups": [
    {"id": "edge", "label": "Edge / CDN", "kind": "zone", "nodes": ["web"]}
  ],
  "notes": ["Card footer note; <=140 chars each, max 4"]
}
```

Rules:
- `nodes`: 1..40; `id` matches `^[a-z][a-z0-9-]{0,31}$` and is unique.
- `kind` for nodes ∈ `service | datastore | actor | external | queue | compute | security | state | note`.
- `edges`: 0..80; `from`/`to` must exist and must not be equal; `kind` ∈
  `main | return | async | security | message | data`; duplicate (from,to,label)
  is invalid.
- `groups` (optional): `id` unique, `nodes` non-empty subset of node ids, no
  node in two groups; `kind` ∈ `zone | boundary | fragment` (`fragment` only for
  `type: sequence`, and a fragment group must reference only participant nodes).
- `type: sequence` — nodes are participants in declared order; edges are
  messages in declared order; a node with kind `actor` is drawn as a human
  participant.
- Unknown keys are rejected (strict, helps agents catch typos).

Validator error shape (must match exactly):

```json
{"ok": false, "errors": [{"code": "ir/duplicate-id", "message": "...", "path": "nodes[3].id", "hint": "..."}],
 "warnings": [{"code": "ir/edge-label-long", "message": "...", "path": "edges[2].label"}]}
```

## 2. scene v1 (layout output, consumed by the view)

All units are CSS px, positions are top-left of the node box. Layout must be
deterministic (same IR → byte-identical scene) and fit inside `width/height`
with `meta.padding` margins.

```json
{
  "sceneVersion": 1,
  "type": "architecture",
  "direction": "TB",
  "width": 1180, "height": 760,
  "title": "...", "subtitle": "...", "notes": ["..."],
  "nodes": [
    {"id": "web", "label": "Web App", "sublabel": "React, edge-cached",
     "kind": "service", "group": "edge", "shape": "card",
     "x": 40, "y": 60, "w": 168, "h": 64}
  ],
  "groups": [
    {"id": "edge", "label": "Edge / CDN", "kind": "zone",
     "x": 16, "y": 36, "w": 320, "h": 220}
  ],
  "edges": [
    {"id": "e1", "from": "web", "to": "api", "label": "GET /cart", "kind": "main",
     "dashed": false, "arrow": "end",
     "points": [{"x": 208, "y": 92}, {"x": 232, "y": 92}, {"x": 232, "y": 140}, {"x": 300, "y": 140}],
     "labelBox": {"x": 236, "y": 104, "w": 62, "h": 18}}
  ],
  "legend": [{"label": "Main request", "kind": "main"}],
  "meta": {"padding": 24, "sceneVersion": 1}
}
```

- `shape` ∈ `card | pill | diamond | box | note | participant`.
- Edge `points` are an orthogonal-ish polyline in draw order; the view draws a
  polyline and puts the arrowhead on the last point. `labelBox` may be omitted
  when there is no label.
- For `sequence`: participants are nodes (`shape: "participant"`, laid out in
  one horizontal row with a full-height lifeline each; put the lifeline extent
  into node `h`), messages are edges with exactly 2 points (left→right or
  right→left at the message y), groups may be `kind: "fragment"` (loop/alt band).
- `legend`: derived from the kinds actually used, max 6 entries, in the order
  main, return, async, security, message, data.
- `notes`: copied from IR, max 4.

## 3. Modules and exports (no writer touches another writer's paths)

```
src/layout/index.mjs     -> export function layout(ir) : scene      (owner: layout)
src/layout/geometry.mjs  -> helpers used by index.mjs                (owner: layout)
src/validate/schema.json -> machine-readable IR schema               (owner: cli)
src/validate/index.mjs   -> export function validate(ir) : {ok, errors, warnings}   (owner: cli)
src/view/compose.mjs     -> export function compose({scene, options}) : string   (owner: view)
src/view/template.html   -> HTML shell with {{STYLE}} {{BODY}} {{SCRIPT}} slots   (owner: view)
src/view/theme.css       -> design tokens + styles                     (owner: view)
src/view/viewer.js       -> interactions (focus, zoom, theme, print)   (owner: view)
src/cli/naqsha.mjs       -> CLI entry (see below)                      (owner: cli)
test/*.test.mjs          -> node:test suites                           (owner: cli)
```

`compose` options: `{mode: "light"|"dark"|"auto"}` default `"auto"`. It inlines
CSS and JS (single file, no external requests, no fonts fetched over network).

## 4. CLI (owner: cli)

```
naqsha validate <in.json> [--json]
naqsha render   <in.json> <out.html> [--mode light|dark|auto] [--json]
naqsha demo     <outdir>
naqsha doctor
naqsha screenshot <html> <out.png> [--width 1440 --height 980]
```

- `render` = validate → layout → compose → atomic write (temp file + rename).
  Exit 0 with `--json` receipt `{"ok":true,"input":...,"output":...,"bytes":N,"nodes":N,"edges":N}`;
  exit 1 with the validator errors shape on failure.
- `screenshot` finds a real Chrome/Chromium (never `/usr/bin/chromium-browser`
  snap shim; env `NAQSHA_CHROME` overrides), then
  `chrome --headless=new --no-sandbox --hide-scrollbars --window-size=W,H
  --virtual-time-budget=4000 --screenshot=OUT file://HTML`.
- `doctor`: node version, chrome path, module load check, and one end-to-end
  render of the built-in smallest example.
- Never write outside the requested output path (and a sibling temp file).

## 5. Brand tokens (owner: view implements, lead owns naming)

Brand name **Naqsha** (an Urdu word meaning map/plan). Wordmark: lowercase `naqsha` set in the
display stack, plus a 20x20 inline SVG mark (stylised route: two nodes and a
bent connector). No emoji, no gradients, no purple, no glassmorphism, no
oversized rounded cards.

Light theme:
- paper `#F8F6F2`, panel `#FFFFFF`, ink `#14171A`, muted ink `#5C636B`,
  hairline `#E3DED5`, grid dot `#DCD6CB`
- accent (primary path) `#B4661F` copper; teal `#1D6A62`; ink-blue `#2B4A6F`;
  alert `#A83E32`; amber `#A97A1F`
Dark theme (`prefers-color-scheme: dark` + explicit toggle):
- page `#0F1214`, panel `#161A1D`, ink `#F2EFE9`, muted `#9AA1A7`,
  hairline `#262B2F`, grid dot `#22272B`, accents same hue, +12% lightness

Type scale: 11 / 12 / 13 / 15 / 18 / 26 px; display 26px with -0.01em tracking;
labels 12px; sublabels 11px; tabular numerals for any counts. Card radius 6px,
pill 999px, hairline 1px, card padding 10x12, canvas padding 24.

Kind → colour: service ink, datastore teal, actor ink-blue, external muted,
queue amber, compute ink-blue, security alert, state teal, note muted.
Edge styles: main = 1.5px solid + filled arrow; return = 1.25px dashed + open
arrow; async = 1.25px dotted; security = 1.5px alert; message = 1.25px solid;
data = 1.5px dotted teal.

Interactions the view must implement: hover/click focus (highlight the node,
its inbound/outbound edges, and 1-hop neighbours; dim the rest), wheel zoom +
drag pan with a reset control, theme toggle, focus mode (`f`), export hint, and
`@media print` that hides chrome and prints the diagram on one page.

Accessibility: `role="img"` + `aria-label` on the SVG, keyboard focusable nodes,
`prefers-reduced-motion` respected, contrast >= 4.5:1 for text.

## 6. Acceptance (lead runs it)

1. `node src/cli/naqsha.mjs demo /tmp/naqsha-demo` renders 3 examples and all
   pass `validate`; every HTML opens with zero console errors.
2. Screenshots at 1440x980 and 390x844: `document.documentElement.scrollWidth -
   innerWidth === 0` on each, no console/page errors.
3. Node overlap check on all 3 scenes: no two node boxes intersect (except a
   node inside its own group), every edge point inside the canvas.
4. Single HTML <= 160 KB (v1.1 live features), no external requests (grep for
   `http://`/`https://` in output = 0 hits except the brand homepage line).
5. Determinism: two renders of the same input are byte-identical.

---

# v1.0 additions (contract v2, additive — nothing above changes)

These four capabilities are what no other free diagram skill ships together:
guided walkthroughs, diagram **diff** artifacts, path tracing, path→scene IR
conversion from Mermaid, a self-healing `fix`, client-side SVG/PNG export, and
client-side SVG/PNG export. Everything stays zero-dependency and offline.

## IR v1.1 (optional fields)

```json
{
  "walkthrough": [
    { "title": "Request arrives",       // 1..60 chars
      "text": "The agent writes a typed candidate and runs the CLI.",  // 1..220
      "focus": ["agent", "cli"]  // 1..6 existing node ids, in reading order
    }
  ]
}
```

- `walkthrough`: max 10 steps; every `focus` id must exist; a step may focus 1..6
  nodes. Validator codes: `ir/walkthrough-count`, `ir/walkthrough-focus`,
  `ir/walkthrough-text`.

## scene v2 (additive fields)

```json
{
  "meta": { "padding": 24 },
  "walkthrough": [ { "n": 1, "title": "...", "text": "...", "focus": ["agent"] } ],
  "diff": { "base": "main", "head": "PR #42", "added": 2, "removed": 1, "changed": 3 },
  "nodes": [ { "id": "x", "status": "added" } ],      // added | removed | changed (diff only)
  "edges": [ { "id": "e1", "status": "removed" } ]    // added | removed | changed (diff only)
}
```

## New modules and exports

```
src/diff/index.mjs      -> export function diff(irBase, irHead) : {ir, summary, changes}   (owner: diff)
                        -> export function shortestPath(ir, fromId, toId) : {ok, path, edges, hops, reason}
src/convert/mermaid.mjs -> export function convertMermaid(text, {type}) : {ok, ir, warnings, errors}   (owner: convert)
src/repair/index.mjs    -> export function repair(ir) : {ir, changes}                      (owner: convert)
```

### diff() rules
- Identity: nodes by `id`; edges by `from|to|label` (a `kind` change is `status: "changed"`, never remove+add, so the merged IR can never contain duplicate edges).
- `ir` returned is a merged **valid** IR (our v1.1 schema) whose nodes/edges carry
  `status`; base nodes missing in head are `removed`, new ones `added`, same id
  with different `label|sublabel|kind` is `changed`; unchanged keep no status.
- `summary = {addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, changedEdges}`
  and `changes = [{entity:"node"|"edge", id, status, before?, after?}]` (max 200).
- Merged IR keeps `title`/`subtitle` of head with `" (diff)"` suffix allowed;
  `groups` only from head plus groups still referenced by removed nodes.

### shortestPath() rules
- Undirected BFS over edges; `path` = node ids shortest, `edges` = edge keys
  (`from|to|kind|label`), `hops = path.length - 1`; `reason` when not found
  (`unreachable`, `unknown-from`, `unknown-to`).

### convertMermaid() rules
- Input dialects: `flowchart`/`graph` (TD/TB/LR/RL/BT, `A[Label]`, `A{Decision}`,
  `A((Pill))`, edge labels `-->|lbl|`, `---`, `-.->`, `==>`, `subgraph` → group),
  `sequenceDiagram` (participant/actor declarations or implicit, `->>`, `-->>`,
  `->`, `-x`, `Note over`, `loop`/`alt`/`opt` → fragment group).
- `type: "auto"` → `workflow` for flowcharts (or `architecture` when the graph has
  2+ subgraphs and only component-looking nodes), `sequence` for sequenceDiagram.
- Returns `{ok, ir, warnings[], errors[{code,message,line}]}` with 1-based line
  numbers; output IR MUST pass our own `validate()` without `fix`.
- Unsupported directives (classDef, click, style, direction inside subgraph) are
  warnings, not failures.

### repair() rules
- Deterministic, idempotent. Repairs: unknown top-level/node/edge/group keys
  (drop + change note), missing `kind` (infer from id/label keywords, else
  `service`), id normalization (`Web App` → `web-app`, dedupe with `-2`), edge
  endpoints pointing at normalized ids, duplicate edges (drop later), missing
  `title` (derived from type), group ids normalized, `type` missing (from shape
  heuristics: sequence if edges look like messages). Never deletes nodes or
  edges except exact duplicates. `changes = [{code, path, note}]` (max 100).

## Viewer requirements (owner: view)

1. **Walkthrough**: if `scene.walkthrough.length > 0`, a tour bar appears under
   the title: `‹ 1 / 3 ›`, caption (title bold + text), progress dots. Keys:
   `→`/`Space` next, `←` prev, `t` toggle tour, `Escape` exit. Each step applies
   a *set* focus (all `focus` ids highlighted, their 1-hop neighbours active,
   rest dimmed) and keeps the existing pin/hover focus working when the tour is
   off. Screen-reader: announce step title via the existing live region.
2. **Multi-focus**: focus engine accepts several ids (`is-focus` on each).
3. **Diff styling**: `status: added` = teal 1.5px outline + `+` badge; `removed`
   = alert dashed outline, 45% opacity, `−` badge, pointer-events none;
   `changed` = amber outline + `~` badge. Header shows `+n −n ~n` chips and a
   diff legend; `removed` nodes still occupy layout.
4. **Export**: toolbar gains an export button that downloads the diagram as
   **SVG** (serialize the scene svg with the theme CSS inlined and a white/paper
   background) and **PNG** (that SVG → `<img>` → canvas at 2× → `toBlob`),
   filename `<slug>-<type>.svg|.png`. No network, no libs; must work from
   `file://`. Also keep the print button.
6. Everything above must keep the existing 39 acceptance + 24 interaction checks
   green (no truncation, no upscale-fit, overflow 0, console 0).

---

# v1.1 viewer batch (live HTML parity with the best viewers on the web)

Competitive research (live viewers of comparable skills: diagview, stackmap) says a
best-in-class interactive diagram page needs: a minimap, search, shareable view
state, legend filtering, an inspector, in-page route tracing, a presentation
laser, keyboard help, multiple raster export formats, and clipboard copy. All of
it must stay in one offline file, no dependencies, no network.

## scene/IR additions (already valid v1.0)
- `compose` embeds the source IR as `<script type="application/json" id="naqsha-ir">`
  (JSON-escaped, no `</script>`) so in-page exports and "copy as Mermaid" work
  without asking the CLI.
- Every node/edge keeps its `data-*` attributes; groups keep `data-group-id`.

## Viewer requirements (owner: view; all offline, no libs)

1. **Minimap** — fixed bottom-right panel (≈180×120 max), scaled copy of node/group
   boxes, a viewport rectangle, click/drag to navigate; hides in print and on
   viewports < 640 px; never overlaps legend/footer.
2. **Search** — `/` or `Ctrl+F` opens an in-page search field (not the browser
   one): typing filters by label/sublabel/kind, matches get `.is-match`, others
   dim; Enter focuses the first match and pans it into view; Escape closes.
3. **Share state** — push `#focus=<id>`, `#step=<n>`, `#z=<scale>`, `#route=<a>~<b>`
   to `location.hash` on interaction; restore them on load (unknown ids ignored,
   never throw). A "Copy link" toolbar action copies `location.href` with a
   transient "Copied" confirmation; works offline from file://.
4. **Legend filtering** — clicking a legend entry hides/shows that edge kind
   (`.is-kind-hidden`), click again restores; a "reset" affordance appears when
   any filter is active; filtering never breaks focus/hover.
5. **Inspector** — clicking a node opens a right side panel: label, kind, group,
   inbound/outbound neighbour lists (clickable → focus + pan), and a "trace from
   here" action; Escape or the close button dismisses; panel is keyboard reachable
   and announced in the live region.
6. **In-page route tracing** — `r` or "Trace" enters route mode: first node click
   = start, second = target; the shortest path highlights with hop count and the
   path list appears in the status line + inspector; Escape cancels. Path search
   must match the CLI (`src/diff/index.mjs shortestPath`) semantics: undirected,
   declaration-order BFS.
7. **Presentation laser** — `p` toggles presentation mode: chrome hides (like focus
   mode), a soft laser dot follows the pointer, Escape exits; no persisted state.
8. **Keyboard help overlay** — `?` opens a dismissible shortcut sheet listing
   every binding (fit, zoom, focus, tour, search, route, presentation, print).
9. **Motion** — on focus/route, animate the highlighted path with a short dash
   offset sweep; disabled under `prefers-reduced-motion`.
10. **Export menu** (extend the existing one) — SVG, PNG (2×), WebP, JPEG, and
    "Copy as Mermaid" (uses the embedded IR + the new `src/convert/to-mermaid.mjs`)
    plus "Copy JSON"; all client-side, filenames `<slug>-<type>.<ext>`.
11. **Mobile** — pinch-to-zoom (two-pointer distance) and double-tap to reset,
    on top of the existing pan/clamp; no page overflow at 390×844.

## IR → Mermaid (owner: convert; new module)

`src/convert/to-mermaid.mjs` → `export function toMermaid(ir)` → `{ok, mermaid, warnings}`:
- `workflow`/`architecture` → `flowchart TD|LR` (subgraph for each group, node
  shapes from kind: card → `[label]`, actor → `([label])`, datastore → `[(label)]`,
  security → `{label}`, note → `>label]`); edges → `-->|label|` with `-.->` for
  async/return kinds, `==>` for security.
- `sequence` → `sequenceDiagram` with participants in declared order and messages
  in declared order (`->>` main, `-->>` return, `-)` async); fragments become
  `loop`/`opt` blocks around their messages.
- Round-trip requirement: `convertMermaid(toMermaid(ir).mermaid).ir` must keep the
  node labels, node count, and edge count (types may differ: architecture may come
  back as workflow) — test it.

---

# v1.2 — the other seven diagram types

Goal: parity with the widest diagram skills (10 types) **plus** our own
live/diff/walkthrough advantages. Every new type must render into the same single
offline HTML, keep the same viewer features (focus, inspector, search, legend,
minimap, route — route/focus are node-based and work for all types), validate
with actionable hints, and pass the same gates.

`type` enum becomes: `architecture | workflow | sequence | erd | class | tree |
timeline | waterfall | dataflow | lifecycle`.

## IR per type (extra fields; everything above still applies)

```json
{ "type": "erd", "nodes": [{ "id": "orders", "label": "orders", "kind": "datastore",
    "attributes": [
      { "name": "id", "type": "uuid", "key": "pk" },
      { "name": "customer_id", "type": "uuid", "key": "fk", "ref": "customers.id" }
    ] }],
  "edges": [{ "from": "customers", "to": "orders", "cardinality": "1:n", "label": "places" }] }

{ "type": "class", "nodes": [{ "id": "payment", "label": "PaymentGateway",
    "stereotype": "interface", "members": ["+ charge(amount): Receipt", "- retry: int"] }],
  "edges": [{ "from": "stripe", "to": "payment", "kind": "implements" }] }

{ "type": "tree", "nodes": [{ "id": "root", "label": "monorepo" }],
  "edges": [{ "from": "root", "to": "apps" }] }

{ "type": "timeline", "nodes": [{ "id": "first-visit", "label": "First visit", "at": "2026-03-01", "lane": "product" }] }

{ "type": "waterfall", "nodes": [{ "id": "dns", "label": "DNS", "start": 0, "duration": 40 }] }

{ "type": "dataflow", "nodes": [{ "id": "raw", "label": "Raw events", "stage": "ingest", "kind": "datastore" }] }

{ "type": "lifecycle", "nodes": [{ "id": "draft", "label": "Draft" }],
  "edges": [{ "from": "draft", "to": "review", "label": "submit" }] }
```

Per-type rules (validator):
- **erd**: every node needs `attributes` (1..12 rows); row `name` required, `type`
  required, `key` ∈ `pk|fk|unique|null`, `ref` must be `entity.attribute` of an
  existing entity. Edges need `cardinality` ∈ `1:1|1:n|n:m`.
- **class**: `members` 0..12 strings (each <=60 chars); `stereotype` ∈
  `interface|abstract|class|null`; edge `kind` ∈ `extends|implements|association|
  composition|dependency` (default `association`).
- **tree**: each node has at most one incoming edge, exactly one root (no incoming
  edge), the graph is acyclic, and every node is reachable from the root. The IR
  still uses `edges` (the renderer draws them); `kind` is ignored.
- **timeline**: every node needs `at` (ISO `YYYY-MM-DD` date, or a number); `lane`
  optional string; at least 2 events.
- **waterfall**: every node needs `start` (number >= 0) and `duration` (number > 0);
  optional `lane`.
- **dataflow**: optional `stage` string per node (declaration order defines the
  columns); edges are flows.
- **lifecycle**: nodes are states; edges are transitions (label = event); the
  layout marks the entry state (no incoming) and terminal states (no outgoing).

Limits: nodes 1..40, edges 0..80 in every type (same as today).

## Scene v3 additions (all additive)

```json
{
  "type": "erd",
  "axis": { "kind": "time|numeric", "min": 0, "max": 1, "ticks": [{ "x": 40, "label": "Mar 1" }] },
  "lanes": [{ "id": "product", "label": "Product", "y": 40, "h": 120 }],
  "nodes": [{
    "id": "orders", "shape": "entity|class|event|span|stage|state|card|pill|box|note|participant",
    "kind": "datastore",
    "rows": [{ "label": "id", "right": "uuid", "mark": "pk" }],   // erd/class bodies
    "bar": { "start": 0, "duration": 40 },                         // waterfall spans
    "stereotype": "interface",                                     // class
    "role": "root|start|end|state|leaf",                           // tree/lifecycle
    "at": "2026-03-01"                                             // timeline events
  }],
  "edges": [{ "id": "e1", "from": "a", "to": "b", "card": "1:n", "status": null }]
}
```

Rendering requirements (owner: view): entity boxes with a header row and
type/name columns (PK/FK marks), class boxes with stereotype tag and member rows,
tree cards with root/leaf roles, timeline events on lane bands with axis ticks,
waterfall bars with span labels, dataflow stage columns with stage headers,
lifecycle state cards with start/end emphasis. Cardinality labels (`1:n`) sit at
the edge ends; class relation kinds get distinct arrowheads (hollow triangle for
extends/implements, filled diamond for composition).

## Module ownership

```
src/layout/types/erd.mjs        owner: types-relational   export layoutErd(ir) -> scene
src/layout/types/class.mjs      owner: types-relational   export layoutClass(ir) -> scene
src/layout/types/tree.mjs       owner: types-relational   export layoutTree(ir) -> scene
src/layout/types/timeline.mjs   owner: types-time         export layoutTimeline(ir) -> scene
src/layout/types/waterfall.mjs  owner: types-time         export layoutWaterfall(ir) -> scene
src/layout/types/dataflow.mjs   owner: types-time         export layoutDataflow(ir) -> scene
src/layout/types/lifecycle.mjs  owner: types-time         export layoutLifecycle(ir) -> scene
src/layout/index.mjs            owner: lead               dispatcher layout(ir) -> scene
src/validate/index.mjs          owner: lead               per-type rules
src/view/*                      owner: view-types         bodies, bars, axis, lanes, roles
examples/*.json                 owner: lead               real-repo showcases, one per type
```

Every layout module returns the **same scene v3 shape** as the existing engine:
`{sceneVersion, type, direction, width, height, title, subtitle?, notes?,
walkthrough?, axis?, lanes?, nodes[], groups[], edges[], legend[], meta}` with
node boxes inside the canvas and 24px padding. Determinism required.
