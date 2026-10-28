# Naqsha usage guide

Naqsha turns one small typed JSON file into one self-contained interactive HTML
page. There is no server, no network request, no account and no runtime
dependency: the page opens from `file://` and works offline.

The commands below use the `naqsha` launcher written by `install.sh`. From a git
checkout without the installer, replace `naqsha` with
`node src/cli/naqsha.mjs` — every argument is identical.

```bash
naqsha --version      # naqsha 1.2.3   (reads the VERSION file)
naqsha version        # same output
naqsha --help         # usage, two examples, exit codes
naqsha doctor         # node, chrome, install layout, end-to-end render
```

## Quick start

1. Install the skill for the agents on this machine (one bash script, no
   dependencies):

   ```bash
   git clone https://github.com/horizonbymuneeb/naqsha && cd naqsha
   ./install.sh --agent all
   ```

   Per-agent commands, the npm route, custom prefixes and uninstall are in
   [INSTALL.md](INSTALL.md).

2. Render a bundled example and open the result:

   ```bash
   naqsha validate examples/engine-repo.architecture.json --json
   naqsha render   examples/engine-repo.architecture.json /tmp/engine.html
   open /tmp/engine.html        # xdg-open on Linux
   ```

3. Ask your coding agent for a diagram instead of writing JSON yourself:

   > Use naqsha to map this repository's runtime architecture. Keep it under 14
   > nodes, group by runtime layer, validate it, and render the HTML to /tmp.

   The agent reads `SKILL.md`, writes one typed candidate, validates it, renders
   the page, and reports the absolute paths of the JSON and the HTML.

4. The smallest useful candidate is only this shape (strict keys — see
   [the six rules](#six-ir-rules-that-cause-most-errors)):

   ```json
   {
     "title": "Checkout service map",
     "type": "architecture",
     "nodes": [
       { "id": "web", "label": "Web App", "kind": "service" },
       { "id": "db", "label": "Orders DB", "kind": "datastore" }
     ],
     "edges": [{ "from": "web", "to": "db", "label": "query", "kind": "data" }]
   }
   ```

## Agent prompt cookbook

One row per common request. The prompt is what the user says; the command is what
the agent should end with. Every scenario finishes the same way: `validate` exit
0, `render` exit 0, absolute artifact path in the reply.

| Scenario | Prompt to the agent | What it should run |
|---|---|---|
| Map a repository | "Use naqsha to map this repository's runtime architecture. Group by runtime layer, keep it under 14 nodes, validate and render it." | `naqsha types`, write IR to `.naqsha/repo-map/input.json`, `validate --json`, `render --json` |
| Request path (sequence) | "Draw the lifecycle of a `POST /checkout` request as a sequence diagram: browser, gateway, checkout, queue, database. Include the returns and the failure path." | `validate`, `render` with `"type": "sequence"` |
| Process or CI workflow | "Turn the steps in this document (or our CI pipeline) into a workflow diagram with the decision branches and retry loop." | `render` with `"type": "workflow"` |
| Database schema (ERD) | "Build an ERD from the tables in `schema.sql`: columns with types, primary and foreign keys, relationship cardinalities." | `render` with `"type": "erd"`, `attributes`, edge `cardinality` |
| Release history (timeline) | "Put the releases from `CHANGELOG.md` on a timeline, one lane per component, with the dates that are stated." | `render` with `"type": "timeline"`, node `at` |
| Compare two versions | "Compare the service architecture before and after this pull request; render the diff and summarize what was added, removed and changed." | two IRs, then `naqsha diff base.json head.json out.html` |
| Trace a route | "Which route does a request take from the gateway to the ledger database? Trace it, quote the hop list, and point at the artifact." | `naqsha path ir.json gateway ledger-db` |
| Mermaid in | "Convert this Mermaid diagram to naqsha, repair whatever it cannot express, and render the HTML." | `naqsha convert in.mmd candidate.json`, `naqsha fix`, `render` |
| Heal a candidate | "This candidate JSON fails validation. Repair it with `naqsha fix`, then render it and report any warnings that remain." | `naqsha fix input.json --out input.fixed.json --json`, `validate`, `render` |

Prompts work best when they name the artifact type, the scope (node limit, which
system), the audience, and where to write the result. Leave dates, prices and
counts to the user's source text; do not invent them.

## Agent workflow

The same six steps every time. Keep one folder per request and reuse it for
repairs — the workflow is reproducible and the JSON stays reviewable.

1. **Pick the type.** `naqsha types` lists all ten. If the request is about
   composition use `architecture`; order use `workflow`; messages over time use
   `sequence`; stored data use `erd`; types use `class`; containment use `tree`;
   dates use `timeline`; durations use `waterfall`; data movement use `dataflow`;
   states use `lifecycle`.

2. **Write the IR** to `.naqsha/<slug>/input.json` in the user's working
   directory (never inside the skill root). Aim for 5–14 nodes and 6–18 edges; a
   diagram that needs 30 nodes needs two diagrams.

3. **Validate** with receipts:

   ```bash
   naqsha validate .naqsha/<slug>/input.json --json
   ```

   Exit 0 means accepted. Warnings are advisory; errors are not. A receipt is
   one JSON object on stdout.

4. **Repair, bounded to 3 rounds.** Each error carries `code`, `path` and `hint`.
   Fix exactly what the hint says, keep the rest of the file unchanged, and
   re-run the same command. For mechanical damage run:

   ```bash
   naqsha fix .naqsha/<slug>/input.json --out .naqsha/<slug>/input.fixed.json --json
   ```

5. **Render** once validation is clean:

   ```bash
   naqsha render .naqsha/<slug>/input.json .naqsha/<slug>/<slug>.html --json
   ```

   Never hand-edit the generated HTML; edit the JSON and re-render.

6. **Check the artifact when Chrome is available**, then report:

   ```bash
   naqsha screenshot .naqsha/<slug>/<slug>.html .naqsha/<slug>/<slug>.png
   ```

   If the screenshot fails, say that the render passed and the screenshot did
   not — do not claim visual quality you did not see. Report the absolute paths
   of `input.json` and the HTML, and offer the next move in one line.

Exit codes are part of the contract: `0` success, `1` validation/render/runtime
failure, `2` usage error. A non-zero exit is never success.

## CLI recipes

Every command prints human-readable output by default and exactly one JSON
object on stdout with `--json` (errors included). Failed commands exit non-zero
and never leave a half-written artifact: files are written to a sibling temp file
and renamed into place.

| Command | Does | Receipt keys (`--json`) |
|---|---|---|
| `validate` | schema + cross-field rules; warnings do not fail | `ok, input, nodes, edges, errors, warnings` |
| `render` | validate → layout → compose → one HTML file | `ok, input, output, bytes, nodes, edges` |
| `diff` | two IRs in, one red/green diff artifact out | `ok, base, head, output, bytes, summary, changes` |
| `path` | shortest route between two node ids | `ok, input, from, to, path, edges, hops, reason` |
| `convert` | Mermaid flowchart/sequence → IR | `ok, input, output, type, nodes, edges, warnings` |
| `mermaid` | IR → Mermaid source (architecture, workflow, sequence) | `ok, input, output, bytes, warnings` |
| `fix` | deterministic repair of a sloppy candidate | `ok, input, output, changes, remainingErrors, warnings` |
| `screenshot` | headless Chrome capture of the HTML | `ok, html, output, bytes, width, height, chrome` |
| `demo` | render every `examples/*.json` into a folder | `ok, outdir, count, files, warnings` |
| `doctor` | environment and end-to-end report | `ok, node, chrome, checks` |
| `types` | the ten-type catalog | `ok, types` |
| `version`, `--version` | CLI version from `VERSION` | plain text, e.g. `naqsha 1.2.3` |

### Validate

```bash
$ naqsha validate examples/engine-repo.architecture.json --json
{"ok":true,"input":".../examples/engine-repo.architecture.json","nodes":15,"edges":16,"errors":[],"warnings":[]}
```

On failure the same receipt is printed with `ok:false` and the validator error
shape: `{ code, message, path, hint }` per error, `{ code, message, path }` per
warning. Human mode prints one `error <code> at <path>` line plus a `hint:` line
per error.

### Render

```bash
$ naqsha render examples/engine-repo.architecture.json /tmp/engine.html --json
{"ok":true,"input":".../engine-repo.architecture.json","output":"/tmp/engine.html","bytes":125056,"nodes":15,"edges":16}
```

`--mode light|dark|auto` selects the initial theme; the page still toggles.
`demo <outdir>` renders every `examples/*.json` into a folder for a quick tour of
all ten types.

### Diff

```bash
$ naqsha diff examples/engine-repo.v31.architecture.json \
               examples/engine-repo.architecture.json /tmp/drift.html --json
{"ok":true,"base":"...","head":"...","output":"/tmp/drift.html","bytes":127224,
 "summary":{"addedNodes":1,"removedNodes":0,"changedNodes":3,"addedEdges":1,"removedEdges":0,"changedEdges":0},
 "changes":5}
```

Entity identity is `from|to|label` for edges and the node id for nodes. A label
edit is "changed", never remove + add. Added is teal, removed is dashed/alert,
changed is amber; the header carries the counts.

### Path

```bash
$ naqsha path examples/engine-repo.architecture.json agent artifact --json
{"ok":true,"input":"...","from":"agent","to":"artifact","path":["agent","cli","artifact"],
 "edges":["agent|cli|main|run command","cli|artifact|main|deliver"],"hops":2,"reason":null}
```

The search is undirected and follows declaration order, matching what the
in-page `r` route tracer does.

### Convert a Mermaid diagram

Supported dialects: `flowchart` / `graph` and `sequenceDiagram`.

```bash
$ naqsha convert test/mermaid/sequence-loop.mmd /tmp/sequence.json --json
{"ok":true,"input":".../sequence-loop.mmd","output":"/tmp/sequence.json","type":"sequence","nodes":4,"edges":6,"warnings":[]}

# force a family when auto-detection would guess wrong
naqsha convert flow.mmd candidate.json --type workflow
```

Sample inputs live in `test/mermaid/`. Convert first, then repair by hand only
where the semantics matter — never re-draw from scratch.

### Export back to Mermaid

```bash
$ naqsha mermaid examples/engine-repo.architecture.json /tmp/engine.mmd --json
{"ok":true,"input":"...","output":"/tmp/engine.mmd","bytes":1206,
 "warnings":[{"code":"to-mermaid/walkthrough-dropped","message":"4 walkthrough step(s) have no Mermaid equivalent..."}]}
```

Sublabels, notes and walkthrough have no Mermaid equivalent; the warnings say
what was dropped so the reply can mention it.

### Fix a sloppy candidate

```bash
$ naqsha fix .naqsha/checkout/input.json --out .naqsha/checkout/input.fixed.json --json
{"ok":true,"input":"...","output":"...input.fixed.json",
 "changes":[{"code":"repair/unknown-key","path":"bogus_key","note":"unknown top-level key \"bogus_key\" dropped"},
            {"code":"repair/node-kind","path":"nodes[0].kind","note":"unknown node kind \"bogus\"; inferred \"service\""}],
 "remainingErrors":[],"warnings":[]}
```

`fix` normalizes ids (`Web App` → `web-app`), infers missing kinds, rewrites
references, drops unknown keys and exact duplicate edges, and reports every
change. Without `--write` or `--out` it prints the repaired IR to stdout. It is
deterministic and idempotent. It cannot invent missing semantics: if
`remainingErrors` is not empty, fix the rest by hand.

### Screenshot

```bash
$ naqsha screenshot /tmp/engine.html /tmp/engine.png --width 1440 --height 980 --json
{"ok":true,"html":"/tmp/engine.html","output":"/tmp/engine.png","bytes":96705,
 "width":1440,"height":980,"chrome":"/usr/bin/google-chrome"}
```

Uses headless Chrome with `--headless=new --no-sandbox --hide-scrollbars
--window-size=W,H --virtual-time-budget=4000`. Chrome is needed only for this
command and the browser-check harnesses; rendering is pure Node.

### Demo and doctor

```bash
naqsha demo /tmp/naqsha-demo --json     # every bundled example, in one pass
naqsha doctor                           # node, chrome, modules, end-to-end render
```

`doctor` prints four checks and a summary:

```text
naqsha doctor
  node     ok    v26.7.0 (need >= 18)
  chrome   ok    /home/you/.cache/ms-playwright/chromium-1248/chrome-linux-arm64/chrome
  modules  ok    src/layout/index.mjs ok · src/view/compose.mjs ok
  render   ok    99590 bytes, 2 nodes, 1 edges (in memory)
doctor: ok — 4/4 checks passed
```

Use `--json` for a machine-readable report (`{ok, node, chrome, checks}`).

## Which type when

| Type | Use it when | Not for | Extra IR fields |
|---|---|---|---|
| `architecture` | you are describing what a system is made of: services, stores, humans, third parties, trust boundaries | ordered processes, timelines | — |
| `workflow` | order matters: steps, decisions, retries, failure branches | topology of a running system | `direction` (TB/LR) |
| `sequence` | who talks to whom over time: participants, messages, returns | static dependency maps | order of `nodes` and `edges` is meaningful |
| `erd` | stored data: tables, columns, keys, relationships | API calls or process flow | node `attributes[{name,type,key,ref}]`, edge `cardinality` |
| `class` | types in code: interfaces, abstract classes, members, inheritance | runtime topology | `stereotype`, `members[]`, edge `kind` |
| `tree` | strict single-parent containment: file trees, org charts, taxonomy | graphs with shared children | `edges` still draw the hierarchy |
| `timeline` | dated events on one axis, optionally per lane | durations, process order | node `at`, optional `lane` |
| `waterfall` | spans with a start and a duration on one time axis | dependencies | node `start`, `duration`, optional `lane` |
| `dataflow` | how data moves through pipeline stages, left to right | request/response messaging | optional node `stage` |
| `lifecycle` | states a thing can be in and the events that move it | sequence of calls between services | edge `label` is the transition |

Choosing in one line: composition → `architecture`, order → `workflow`,
conversation → `sequence`, storage → `erd`, types → `class`, containment →
`tree`, dates → `timeline`, durations → `waterfall`, data movement → `dataflow`,
states → `lifecycle`. `naqsha types` prints the same catalog.

## Six IR rules that cause most errors

The validator is strict on purpose: unknown keys and bad references are rejected
before anything is rendered. These six rules cover almost every failure; each
error carries the exact path and a fix hint.

### 1. Strict shape

`title` (1–80 chars), `type` and `nodes` are required; `edges`, `groups`, `notes`
and `walkthrough` are optional. **Unknown keys are rejected** at every level.

- Root keys are exactly: `title, subtitle, type, direction, nodes, edges, groups,
  notes, walkthrough`.
- Codes: `ir/required`, `ir/unknown-key`, `ir/type`, `ir/unknown-type`.
- Fix: correct the typo (the hint names the likely key) or remove the key. The
  `type` value must be one of the ten listed above.

### 2. IDs and references

Node and group ids match `^[a-z][a-z0-9-]{0,31}$` and must be unique. Every
reference must land on an existing id: edge `from`/`to`, node `group`, group
`nodes[]`, walkthrough `focus[]`.

- Codes: `ir/node-id-format`, `ir/group-id-format`, `ir/duplicate-id`,
  `ir/dangling-ref`, `ir/group-subset`, `ir/unknown-group`, `ir/self-edge`.
- Fix: ids are lowercase kebab-case, not labels. `Web App` becomes id `web-app`
  with `"label": "Web App"`; `snake_case` becomes `snake-case`.

### 3. Kinds and enums

`kind` values are enums, and `kind` is required for `architecture`, `workflow`
and `sequence` (the other seven types have sensible defaults). Node kinds:
`service, datastore, actor, external, queue, compute, security, state, note`.
Edge kinds: `main, return, async, security, message, data`. Group kinds:
`zone, boundary, fragment` (`fragment` only in a `sequence` diagram).
`direction` is `TB` or `LR` (`sequence` ignores it with a warning).

- Codes: `ir/unknown-kind`, `ir/unknown-direction`, `ir/fragment-non-sequence`,
  `ir/direction-ignored`.
- Fix: use one of the values the hint lists; do not invent `server`, `sync` or
  `cluster`.

### 4. Per-type fields are mandatory

The seven newer types require their extra fields, not just nodes and edges:

- `erd`: each node has 1–12 `attributes` (`name`, `type`, optional `key` ∈
  `pk|fk|unique|null`, optional `ref` = `"entity.attribute"`); each edge needs
  `cardinality` ∈ `1:1|1:n|n:m`.
- `class`: optional `members[]` (0–12 strings, ≤60 chars each) and
  `stereotype` ∈ `interface|abstract|class|null`; edge `kind` ∈
  `extends|implements|association|composition|dependency`.
- `tree`: exactly one root, at most one parent per node, acyclic, every node
  reachable.
- `timeline`: every node has `at` (ISO `YYYY-MM-DD` or a number); at least
  2 events.
- `waterfall`: every node has `start` (≥ 0) and `duration` (> 0).
- `dataflow`: optional `stage` per node; declaration order defines the columns.
- `lifecycle`: edges are transitions; `label` is the event.

- Codes: `ir/erd-attributes`, `ir/erd-ref`, `ir/erd-cardinality`,
  `ir/class-members`, `ir/tree-root`, `ir/tree-parents`, `ir/tree-reachable`,
  `ir/timeline-at`, `ir/timeline-events`, `ir/waterfall-span`.
- Fix: add the field the hint names, or switch to a type that fits the content.

### 5. Edges and groups

`from` and `to` must exist and must differ; duplicate `(from, to, label)` triples
are invalid. Groups are optional but strict: unique ids, a non-empty subset of
node ids, and no node in two groups.

- Codes: `ir/self-edge`, `ir/duplicate-edge`, `ir/group-empty`,
  `ir/group-duplicate-node`, `ir/group-mismatch` (warning).
- Fix: a self-edge needs an intermediate node; a duplicate edge needs a distinct
  label or removal; group members must be declared nodes.

### 6. Counts and lengths

Hard limits: `nodes` 1–40, `edges` 0–80, `title` 80 chars, `subtitle` 120, node
`label` 80, group label 80, `notes` max 4 × 140 chars, `walkthrough` max 10 steps
(step title 60, text 220, `focus` 1–6 ids).

- Codes: `ir/nodes-count`, `ir/edges-count`, `ir/title-length`,
  `ir/subtitle-length`, `ir/label-length`, `ir/note-length`, `ir/notes-count`,
  `ir/walkthrough-count`, `ir/walkthrough-text`.
- Soft warnings (`ir/node-label-long`, `ir/sublabel-long`,
  `ir/edge-label-long`) mean the page will still render but may clip or crowd.
- Fix: split into two diagrams; move detail from labels into `sublabel` or
  `notes`; keep labels to 1–4 words.

When errors pile up, run `naqsha fix input.json --json` before hand-editing. The
repair pass is deterministic and idempotent; then validate again and use the
remaining hints for the semantic fixes it cannot guess.

## What the reader gets

Every page is a single offline file; all of this works from `file://`.

| Feature | How to use it |
|---|---|
| Guided tour | `→` / Space next, `←` previous, `t` toggle, Escape exit; appears when the IR has `walkthrough` steps (3–5 works best, max 10) |
| Focus and dim | click or hover a node; `f` toggles focus mode; 1-hop neighbours stay lit, the rest dims |
| Search | `/` or Ctrl/Cmd+F; type to filter labels, sublabels and kinds; Enter flies to the match |
| Route tracing | `r`, click start node then target node; hop count and path list are shown; same algorithm as `naqsha path` |
| Presentation laser | `p` hides the chrome and follows the pointer; Escape exits |
| Keyboard help | `?` opens the complete shortcut sheet |
| Minimap | bottom-right radar; click or drag to navigate; hidden on phones under 640 px |
| Inspector | click a node for its label, kind, group and clickable inbound/outbound neighbours |
| Legend filter | click a legend entry to hide that edge kind, click again to restore |
| Share state | Copy link; the hash carries `#focus=`, `#step=`, `#z=`, `#route=` and is restored on load |
| Export | export button: SVG, PNG (2×), WebP, JPEG, Mermaid, JSON — generated in the browser, offline |
| Print | print button or the browser print dialog; one page, chrome hidden |
| Theme | toolbar toggle: light / dark / system, remembered; honours `prefers-color-scheme` |
| Zoom and pan | wheel zoom, drag pan, `+`/`-` zoom, `0` resets everything |
| Mobile | pinch zoom, double-tap reset, pan; no horizontal page overflow at 390×844 |

Accessibility: the diagram is `role="img"` with an `aria-label`, nodes are
keyboard focusable, a live region announces state changes, reduced-motion
preferences are respected, and body text meets a 4.5:1 contrast ratio.

## Troubleshooting

### Validation fails

Read the receipt, not just the exit code: every error has `code`, `path` and
`hint`. Fix one round at a time (maximum 3 rounds), then re-run the same command.
`ir/json-syntax` means the file is not JSON (comments, trailing commas, single
quotes) — fix the file, not the parser.

### Screenshots fail or Chrome is missing

Rendering never needs a browser; only `screenshot` does.

```bash
naqsha doctor                                    # shows the chrome check
export NAQSHA_CHROME=/path/to/chrome             # or google-chrome / chromium
naqsha screenshot /tmp/engine.html /tmp/engine.png
```

The snap stub `/usr/bin/chromium-browser` is deliberately never accepted. If
`doctor` finds no real Chrome, install Google Chrome/Chromium or point
`NAQSHA_CHROME` at a real binary.

### `doctor` shows a failing check

| Check | Passes when | Fix |
|---|---|---|
| `node` | Node ≥ 18 | upgrade Node |
| `chrome` | a real Chrome/Chromium binary is executable | install one or set `NAQSHA_CHROME` |
| `modules` | `src/layout/index.mjs` and `src/view/compose.mjs` load | reinstall: `./install.sh --agent <name>` |
| `render` | the built-in two-node example validates, lays out and composes | reinstall; this signals a broken or partial copy |

`doctor: ok — 4/4 checks passed` is the all-green line. Use `naqsha doctor --json`
in scripts.

### `render pipeline not ready: <module>`

The installed copy is incomplete: `src/layout/index.mjs` or
`src/view/compose.mjs` is missing (exit code 2). Re-run `install.sh` from the
repository root and confirm with `naqsha doctor`.

### The agent does not know the skill, or uses an old copy

Reinstall for that agent, then **restart the agent session** so it re-reads
`SKILL.md` and the install path. Confirm the target with
`./install.sh --list`, and check the environment with `naqsha doctor`. If you
need to bypass discovery entirely, invoke the installed copy directly:

```bash
node <skill-root>/src/cli/naqsha.mjs render input.json out.html
```

### The page renders but reads badly

Aim for 5–14 nodes and 6–18 edges; split larger systems into two diagrams. Prefer
1–4 word labels with detail in `sublabel`, one `main` path with side behaviour as
`async`/`data`/`return`, and groups that describe ownership or trust boundaries,
not layout columns. For versions use `diff` rather than two hand-built pages; for
routes use `path` or the in-page `r` tracer.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | validation, render or runtime failure (including a failed screenshot) |
| 2 | usage error — bad arguments, unknown flag, unknown command; also used when the render pipeline is not installed |
