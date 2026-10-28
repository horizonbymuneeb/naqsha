# Install naqsha

Naqsha is a **skill** (a folder with `SKILL.md`, the CLI in `src/`, and the
examples) plus an optional **CLI** on your `PATH`. Install it once per agent;
nothing runs in the background and no server is started.

- Requirements: **Node.js ≥ 18** (no npm packages are installed), bash, and
  optionally Chrome/Chromium only for `naqsha screenshot` and the browser-check
  harnesses.
- The installer works offline. It copies files, rewrites the skill's absolute
  path, writes a Chrome hint, and finishes with a real validate + render.

## Quick start — no clone needed

```bash
npm i -g naqsha-cli
naqsha install-skill --agent all      # every agent detected on this machine
naqsha install-skill --list           # show the agent → skills-root map
```

The npm package ships the whole skill payload (`SKILL.md`, `install.sh`, `src/`,
`examples/`), so `install-skill` copies it into each agent's skills root, rewrites
the skill's absolute path and finishes with a real validate + render.

No npm, or offline? Clone and run the same installer:

```bash
git clone https://github.com/horizonbymuneeb/naqsha && cd naqsha
./install.sh --agent all
```

Re-running either form is safe and idempotent; it overwrites its own previous
install.

## One agent at a time

| Agent | Flag | Skills root |
|---|---|---|
| DeepSeek Harness (DSH) | `--agent dsh` | `~/.dsh-home/skills/naqsha` |
| Claude Code | `--agent claude` | `~/.claude/skills/naqsha` |
| Codex | `--agent codex` | `~/.agents/skills/naqsha` |
| Hermes | `--agent hermes` | `~/.agents/skills/naqsha` |
| opencode | `--agent opencode` | `~/.config/opencode/skills/naqsha` |
| Cursor | `--agent cursor` | `~/.cursor/skills/naqsha` |
| Gemini CLI | `--agent gemini` | `~/.gemini/skills/naqsha` |

```bash
naqsha install-skill --agent claude
naqsha install-skill --agent dsh
```

From a clone, the equivalent is `./install.sh --agent claude`.

The agent discovers the skill from that folder — restart the agent session (or
start a new chat) after installing so it re-reads its skill catalog.

## npm details

`npm i -g naqsha-cli` gives the `naqsha` CLI immediately (`naqsha types`,
`naqsha render …`). `naqsha install-skill` is a thin, validated wrapper around the
installer that ships inside the package:

```bash
npm i -g naqsha-cli
naqsha install-skill --agent all     # or --agent claude / --agent dsh
naqsha install-skill --list          # the map
```

On systems where the global prefix needs `sudo`, either fix the npm prefix
(`npm config set prefix ~/.local`) or install the skill from a clone instead.

Windows: `install-skill` needs bash (WSL or Git Bash). Without bash, copy the
package folder into the agent's skills root and replace `{{NAQSHA_ROOT}}` in
`SKILL.md` with its absolute path.

## Custom prefix / CI

```bash
naqsha install-skill --prefix /tmp/naqsha-test --agent dsh
naqsha install-skill --prefix /tmp/naqsha-test --no-verify   # skip the self-check
```

`--prefix DIR` treats `DIR` as `$HOME` for detection and installation, which
keeps test installs out of your real home directory.

## What the installer writes

| Path | Contents |
|---|---|
| `<skills-root>/naqsha/` | `SKILL.md`, `src/`, `examples/`, `brand/`, `LICENSE` |
| `~/.config/naqsha/env.sh` | `NAQSHA_CHROME` hint (only when a real Chrome is found) |
| `~/.local/bin/naqsha` | tiny launcher that calls the installed CLI |

The launcher and the env file are optional: the skill itself calls the CLI by
absolute path, so a missing launcher changes nothing for the agent.

## Using it

Ask the agent for a diagram, or call the CLI yourself:

```bash
naqsha types --json
naqsha validate examples/engine-repo.architecture.json --json
naqsha render examples/engine-repo.architecture.json ~/diagram.html
naqsha doctor                     # checks Node, Chrome and the install layout
```

Inside an agent the flow is: the agent writes one JSON candidate to
`.naqsha/<slug>/input.json`, runs `validate`, fixes what the diagnostics name,
then runs `render` and shows the single HTML file — offline, no dependencies on
the reader's side.

## Upgrade

```bash
npm i -g naqsha-cli@latest && naqsha install-skill --agent all
# or, from a clone:
cd naqsha && git pull && ./install.sh --agent all
```

## Uninstall

```bash
rm -rf ~/.dsh-home/skills/naqsha ~/.agents/skills/naqsha ~/.claude/skills/naqsha \
       ~/.config/opencode/skills/naqsha ~/.cursor/skills/naqsha ~/.gemini/skills/naqsha \
       ~/.local/bin/naqsha ~/.config/naqsha
npm uninstall -g naqsha-cli        # only if installed from npm
```

## Troubleshooting

- **`./install.sh: command not found`** — run it with bash: `bash install.sh`.
- **Windows** — the CLI is plain Node and runs anywhere; the installer is a bash
  script, so use WSL or Git Bash, or copy the folder into the agent's skills
  root manually and replace `{{NAQSHA_ROOT}}` in `SKILL.md` with its absolute path.
- **Screenshots fail** — set `NAQSHA_CHROME=/path/to/chrome`. Snap
  `/usr/bin/chromium-browser` stubs are deliberately ignored because they cannot
  launch a browser.
- **The agent does not see the skill** — confirm `<skills-root>/naqsha/SKILL.md`
  exists and start a new session.
- **Pearl of wisdom** — everything is local; no telemetry, no update check, no
  account. `grep -r http src/` shows only comments.
