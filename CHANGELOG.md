# Changelog

All notable changes to this project are documented here. Format: Keep a Changelog,
versioning: semantic-ish (pre-1.0 was an internal MVP).

## [1.2.3] — 2026-10-28

### Changed
- **Install documentation is per agent.** README now carries the agent →
  skills-root → command table (DSH, Claude Code, Codex, Hermes, opencode,
  Cursor, Gemini CLI) and the npm route; `docs/INSTALL.md` documents the full
  flow, including custom prefixes, upgrading, uninstalling and troubleshooting.
- The npm package is published as **`naqsha-cli`** — `npm i -g naqsha-cli`
  installs the `naqsha` binary, and the same tarball ships `install.sh` and
  `SKILL.md`, so the skill can be registered without cloning.
- `SKILL.md` metadata refreshed: version follows the release and the description
  lists all ten diagram types.

### Verified
- Fresh installs into isolated prefixes for DSH, Claude Code and Codex, plus a
  global npm install followed by the shipped `install.sh` — each ends in the
  installer's own validate + render check (125 KB artifact) and a working
  `naqsha types` / `naqsha validate`.

## [1.2.2] — 2026-10-28

### Changed
- Example files are named after what they show (`engine-repo.architecture.json`,
  `finalize-gates.workflow.json`, `ir-schema.erd.json`, …) instead of after the
  system they describe. Artifacts and screenshots were regenerated from the
  renamed sources.
- README, SKILL.md, the contract and the release notes describe the examples
  generically; the eleven JSON files and twelve HTML demos are unchanged in
  substance.

### Fixed
- `install.sh` exported the wrong Chrome hint variable name into
  `~/.config/naqsha/env.sh`; the tooling reads `NAQSHA_CHROME*`, so the hint now
  matches the docs.

## [1.2.1] — 2026-10-28

### Changed
- **Every public example is now a real production codebase.** The `examples/`
  set and all twelve artifacts under `docs/` describe one shipping diagram
  engine: its v3.2 runtime, the four finalize gates, the typed IR, the release
  history, the measured finalize timings, and the v3.1 → v3.2 diff. The invented
  checkout/incident/shop fixtures and the personal server map are gone.
- `examples/` is flat: eleven showcases, one per diagram type plus a diff pair.

### Fixed
- `naqsha fix` knew only the three v1.0 types and would rewrite a valid
  v1.2 IR into a workflow (dropping `attributes`, `members`, `at`, `start`,
  `duration`, `stage`, `lane`, class relation kinds and ERD cardinality).
  Repair now covers all ten types, passes their fields through untouched and is
  a verified no-op on every shipped example.
- `naqsha mermaid` rejected the seven v1.2 types. They now export as a
  flowchart of their nodes, edges and groups with an explicit
  `to-mermaid/type-simplified` warning; the round trip is verified on all
  eleven examples.
- Repair no longer emits `edges: []` for graph-less diagrams or `kind:
  undefined` on nodes that legitimately have no kind.

## [1.2.0] — 2026-10-28

### Added
- **Seven new diagram types**, bringing the total to ten: `erd` (entity tables,
  columns, PK/FK/unique marks, cardinality pills), `class` (stereotype headers,
  member rows, UML relation heads), `tree` (tidy tree with root/branch/leaf
  roles), `timeline` (time axis, lanes, event leaders), `waterfall` (numeric
  axis, start+duration bars), `dataflow` (stage columns), `lifecycle` (states
  with start/end emphasis).
- `naqsha types` prints the type catalog and each type's extra IR fields.
- Per-type validation rules with actionable hints (ERD attributes/refs,
  class members/stereotypes, tree single-root/acyclic, timeline dates,
  waterfall start+duration).
- One showcase example per type in `examples/`, each with a live artifact
  in `docs/`.
- GitHub Actions CI (Node 20/22/24: unit tests, validate examples, render every
  example, Mermaid round-trip, npm pack).
- npm packaging: `bin`, `files`, `scripts`, `engines` — published as
  **`naqsha-cli`** on npm (`npm i -g naqsha-cli` installs the `naqsha` binary).
  The bare `naqsha` name is rejected by the registry's similarity rules.

### Fixed
- Full-row hit areas (`.node-hit`) for span/event/state shapes so a real click
  anywhere on the row opens the node; timeline events no longer steal their
  neighbour's click.
- ERD/class edges attach to distinct border ports instead of stacking on one
  point.
- Screenshot temp-file assertion is retry-tolerant for slow CI filesystems.

## [1.1.0] — 2026-10-27

### Added
- Live viewer batch: minimap, `/` search, shareable `#focus/#step/#z/#route`
  state with Copy link, legend filtering, inspector panel, in-page route
  tracing (`r`), presentation laser (`p`), `?` shortcut sheet, SVG/PNG/WebP/JPEG
  export, Copy as Mermaid / Copy JSON, pinch-zoom + double-tap reset.
- IR → Mermaid exporter (`naqsha mermaid`) with round-trip tests.
- walkthrough tours (authored 3–10 steps) and diagram diff artifacts
  (`naqsha diff`) with added/removed/changed styling.
- `naqsha path` for shortest-path queries, `naqsha convert` for Mermaid input,
  `naqsha fix` for deterministic IR repair.

### Fixed
- Focus pinning now writes the share hash synchronously (reload restores view).
- Pointer capture no longer swallows real mouse clicks on nodes.
- Pan is a no-op when the scene already fits (minimap clicks stay accurate).

## [1.0.0] — 2026-10-27

First public release: architecture / workflow / sequence diagrams from one JSON
file into one self-contained interactive HTML; validator with fix hints; diff,
tour and export groundwork.

## [0.1.0] — 2026-10-27

Internal MVP: own JSON IR, deterministic layout, hand-built viewer, installer
for DSH/Hermes/Claude Code/Codex/opencode/Cursor/Gemini.
