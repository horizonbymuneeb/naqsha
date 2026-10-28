# Releasing naqsha

## Local gates (must be green before any tag)

```bash
node --test test/                       # unit tests
./verify.sh                             # acceptance checks (needs Chrome)
node scripts/interact-check.mjs --html docs/demo-architecture.html
```

## Version bump

1. `VERSION` and `package.json` → new semver.
2. `CHANGELOG.md` → new section.
3. Regenerate demo artifacts:
   `node src/cli/naqsha.mjs render examples/engine-repo.architecture.json docs/demo-architecture.html --json`
   (same for every file in `docs/demo-*.html` — see README's demo tables).
4. Commit, push `master`.

## Tag + GitHub release

```bash
git tag -a vX.Y.Z -m "naqsha X.Y.Z"
git push origin vX.Y.Z
gh release create vX.Y.Z --title "naqsha vX.Y.Z — <headline>" --notes "<notes>"
```

## npm

```bash
npm login                                  # once per machine
npm publish                                 # publishes "naqsha" (bin: naqsha)
npm view naqsha version                     # verify
npm pack --dry-run                          # tarball sanity
```

The registry account must own the `naqsha` package name; the tarball contains
`SKILL.md`, `src/`, `examples/`, `brand/`, `test/mermaid/`, `install.sh`,
`LICENSE`, `LICENSES/`, `README.md`, `VERSION`.
