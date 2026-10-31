# GitHub Action

Render and lint Naqsha diagrams on every push, and fail the build when a committed
diagram is out of date.

```yaml
name: diagrams
on: [push, pull_request]

jobs:
  naqsha:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: horizonbymuneeb/naqsha@v1.4.0
        with:
          input: "docs/**/*.naqsha.json"
          out-dir: "docs/diagrams"
```

That renders every matched IR file to a self-contained HTML page, lints it, and
uploads the result as a `naqsha-diagrams` artifact.

## Stale-docs gate

The most useful mode for a docs repository: render, then compare with what is
committed. If they differ, the job fails and tells you which diagram to re-render.

```yaml
      - uses: horizonbymuneeb/naqsha@v1.4.0
        with:
          input: "docs/**/*.naqsha.json"
          out-dir: "docs/diagrams"
          check: "true"
```

```
STALE  docs/architecture.naqsha.json -> docs/diagrams/architecture.html

1 diagram(s) are stale — run naqsha render and commit the result.
```

Rendering is deterministic, so a clean run never produces a spurious diff.

## Lint gate

`lint: true` (the default) fails on structural errors — duplicate ids, edges that
point at nothing, empty graphs. `lint-strict: true` also fails on advisories:
orphans, cycles, unlabeled nodes, a readability ceiling.

```yaml
      - uses: horizonbymuneeb/naqsha@v1.4.0
        with:
          input: "docs/**/*.naqsha.json"
          lint-strict: "true"
```

## Commit the result

For a docs site where the HTML is committed rather than built:

```yaml
      - uses: horizonbymuneeb/naqsha@v1.4.0
        with:
          input: "docs/**/*.naqsha.json"
          out-dir: "docs/diagrams"
          commit: "true"
```

This needs a checkout with write access (`permissions: contents: write`).

## Inputs

| input | default | meaning |
|---|---|---|
| `input` | `**/*.naqsha.json` | glob of IR files |
| `out-dir` | `dist/diagrams` | where the HTML goes |
| `mode` | `auto` | `auto`, `light` or `dark` |
| `lint` | `true` | fail on structural lint errors |
| `lint-strict` | `false` | also fail on lint warnings |
| `check` | `false` | fail when a rendered file differs from the committed one |
| `commit` | `false` | commit the rendered files back |
| `upload-artifact` | `true` | upload the diagrams as an artifact |
| `version` | `latest` | `naqsha-cli` version or dist-tag to run |

## Outputs

| output | meaning |
|---|---|
| `rendered` | number of diagrams rendered |
| `stale` | number of committed diagrams that were out of date |

## Without the Action

The same thing in one line, if you already have Node and the CLI:

```bash
npx naqsha-cli@1.4.0 lint docs/architecture.naqsha.json
npx naqsha-cli@1.4.0 render docs/architecture.naqsha.json docs/diagrams/architecture.html
```
