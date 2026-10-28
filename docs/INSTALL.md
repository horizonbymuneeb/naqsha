# Install naqsha

Naqsha is a **skill** (a folder with `SKILL.md`, the CLI in `src/`, and the
examples) plus an optional **CLI** on your `PATH`. Install it once per agent;
nothing runs in the background and no server is started.

- Requirements: **Node.js ≥ 18** (no npm packages are installed), bash, and
  optionally Chrome/Chromium only for `naqsha screenshot` and the browser-check
  harnesses.
- The installer works offline. It copies files, rewrites the skill's absolute
  path, writes a Chrome hint, and finishes with a real validate + render.

## Quick start

```bash
git clone https://github.com/horizonbymuneeb/naqsha
cd naqsha
./install.sh            # every agent detected on this machine
./install.sh --list     # show the agent → skills-root map
```

Re-running it is safe and idempotent; it overwrites its own previous install.

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
./install.sh --agent claude
./install.sh --agent dsh
```

The agent discovers the skill from that folder — restart the agent session (or
start a new chat) after installing so it re-reads its skill catalog.

## From npm

The npm package ships the same skill payload (`SKILL.md`, `install.sh`, `src/`,
`examples/`), so you can install the CLI and register the skill without cloning:

```bash
npm i -g naqsha-cli
naqsha types                     # the CLI works immediately
bash "$(npm root -g)/naqsha-cli/install.sh" --agent all
```

On systems where the global prefix needs `sudo`, either fix the npm prefix
(`npm config set prefix ~/.local`) or install the skill from a clone instead.

## Custom prefix / CI

```bash
./install.sh --prefix /tmp/naqsha-test --agent dsh
./install.sh --prefix /tmp/naqsha-test --no-verify       # skip the self-check
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
cd naqsha && git pull && ./install.sh --agent all
# or, with npm:
npm i -g naqsha-cli@latest && bash "$(npm root -g)/naqsha-cli/install.sh" --agent all
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
