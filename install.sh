#!/usr/bin/env bash
# naqsha installer — one command, every agent, no dependencies, no network.
#
#   ./install.sh                       # install into every agent detected on this box
#   ./install.sh --agent dsh           # one agent
#   ./install.sh --prefix /tmp/h --agent all --no-verify
#   ./install.sh --list                # show agent → skill directory map
#
# Installs the skill directory (SKILL.md + src/ + examples/) into each agent's
# skills root, rewrites the {{NAQSHA_ROOT}} placeholder with the real absolute
# path, writes a Chrome hint env file, and runs a real render as verification.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$REPO_ROOT/VERSION" 2>/dev/null || echo "0.1.0")"
PREFIX="${HOME}"
AGENT="all"
VERIFY=1

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
}

# agent name -> skills root relative to prefix
agent_root() {
  case "$1" in
    dsh)      printf '%s/.dsh-home/skills' "$PREFIX" ;;
    hermes)   printf '%s/.agents/skills' "$PREFIX" ;;
    codex)    printf '%s/.agents/skills' "$PREFIX" ;;
    claude)   printf '%s/.claude/skills' "$PREFIX" ;;
    opencode) printf '%s/.config/opencode/skills' "$PREFIX" ;;
    cursor)   printf '%s/.cursor/skills' "$PREFIX" ;;
    gemini)   printf '%s/.gemini/skills' "$PREFIX" ;;
    *) return 1 ;;
  esac
}

# agent name -> config root that must exist for "detected" (empty = always)
agent_probe() {
  case "$1" in
    dsh)      printf '%s/.dsh-home' "$PREFIX" ;;
    hermes)   printf '%s/.agents' "$PREFIX" ;;
    codex)    printf '%s/.agents' "$PREFIX" ;;
    claude)   printf '%s/.claude' "$PREFIX" ;;
    opencode) printf '%s/.config/opencode' "$PREFIX" ;;
    cursor)   printf '%s/.cursor' "$PREFIX" ;;
    gemini)   printf '%s/.gemini' "$PREFIX" ;;
  esac
}

ALL_AGENTS="dsh hermes codex claude opencode cursor gemini"

while [ $# -gt 0 ]; do
  case "$1" in
    --agent) AGENT="${2:?--agent needs a value}"; shift 2 ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    --no-verify) VERIFY=0; shift ;;
    --list) for a in $ALL_AGENTS; do printf '%-9s %s\n' "$a" "$(agent_root "$a")"; done; exit 0 ;;
    -h|--help) usage ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -d "$PREFIX" ] || { echo "prefix does not exist: $PREFIX" >&2; exit 2; }
case "$AGENT" in all|dsh|hermes|codex|claude|opencode|cursor|gemini) ;; *) echo "unknown agent: $AGENT" >&2; exit 2 ;; esac

# ---------------------------------------------------------------- chrome hint
find_chrome() {
  local c
  for c in "${NAQSHA_CHROME:-}" \
           "$HOME/.cache/ms-playwright/chromium-"*"/chrome-linux"*"/chrome" \
           "$HOME/.cache/ms-playwright/chromium-"*"/chrome-mac/Chromium.app/Contents/MacOS/Chromium" \
           /usr/bin/google-chrome /usr/bin/google-chrome-stable \
           /usr/bin/chromium /opt/google/chrome/chrome \
           "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    [ -n "$c" ] && [ -x "$c" ] && printf '%s' "$c" && return 0
  done
  # snap shim /usr/bin/chromium-browser is deliberately skipped: it is a stub
  # that fails to launch a browser and makes browser checks report EPIPE.
  return 1
}

write_chrome_env() {
  local chrome="$1" envdir envfile
  envdir="$PREFIX/.config/naqsha"
  envfile="$envdir/env.sh"
  mkdir -p "$envdir"
  {
    printf '# naqsha — generated %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'export NAQSHA_CHROME=%q\n' "$chrome"
    printf 'export NAQSHA_CHROME=%q\n' "$chrome"
    if [ "$(id -u)" = "0" ]; then printf 'export NAQSHA_CHROME_NO_SANDBOX=1\n'; fi
  } > "$envfile"
  CHROME_ENV_FILE="$envfile"
}

# ------------------------------------------------------------------- install
install_one() {
  local agent="$1" root target tmp
  root="$(agent_root "$agent")" || return 1
  target="$root/naqsha"
  mkdir -p "$root"
  tmp="$root/.naqsha.$$.tmp"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  cp "$REPO_ROOT/SKILL.md" "$tmp/SKILL.md"
  cp -R "$REPO_ROOT/src" "$tmp/src"
  cp -R "$REPO_ROOT/examples" "$tmp/examples"
  # Mermaid samples ship with the skill so `convert` has something to try
  mkdir -p "$tmp/examples/mermaid"
  cp "$REPO_ROOT"/test/mermaid/*.mmd "$tmp/examples/mermaid/" 2>/dev/null || true
  cp -R "$REPO_ROOT/brand" "$tmp/brand" 2>/dev/null || true
  cp "$REPO_ROOT/VERSION" "$tmp/VERSION" 2>/dev/null || true
  cp "$REPO_ROOT/LICENSES/ATTRIBUTION.md" "$tmp/ATTRIBUTION.md" 2>/dev/null || true
  python3 - "$tmp/SKILL.md" "$target" <<'PY'
import sys
p, root = sys.argv[1], sys.argv[2]
s = open(p, encoding="utf-8").read().replace("{{NAQSHA_ROOT}}", root)
open(p, "w", encoding="utf-8").write(s)
PY
  chmod +x "$tmp/src/cli/naqsha.mjs" 2>/dev/null || true
  rm -rf "$target"
  mv "$tmp" "$target"
  printf '  installed  %-9s -> %s\n' "$agent" "$target"
}

detected=""
for a in $ALL_AGENTS; do
  probe="$(agent_probe "$a")"
  if [ -e "$probe" ]; then detected="$detected $a"; fi
done

targets=""
if [ "$AGENT" = "all" ]; then
  # one skill directory can serve two agents (hermes/codex share ~/.agents)
  seen=""
  for a in $detected; do
    d="$(agent_root "$a")"
    case " $seen " in *" $d "*) continue ;; esac
    seen="$seen $d"
    targets="$targets $a"
  done
  [ -n "$targets" ] || { echo "no agent config found under $PREFIX (use --agent to force)" >&2; exit 2; }
else
  targets="$AGENT"
fi

echo "naqsha $VERSION -> prefix $PREFIX"
if chrome="$(find_chrome)"; then
  write_chrome_env "$chrome"
  printf '  chrome     %s\n' "$chrome"
else
  CHROME_ENV_FILE=""
  printf '  chrome     not found (rendering works; screenshots/browser checks need one)\n'
fi

for a in $targets; do install_one "$a"; done

# manual launcher
BINDIR="$PREFIX/.local/bin"
FIRST_ROOT="$(agent_root "$(echo $targets | awk '{print $1}')")"
mkdir -p "$BINDIR"
cat > "$BINDIR/naqsha" <<EOF
#!/usr/bin/env bash
exec node "$FIRST_ROOT/naqsha/src/cli/naqsha.mjs" "\$@"
EOF
chmod +x "$BINDIR/naqsha"
printf '  launcher   %s\n' "$BINDIR/naqsha"

if [ -n "${CHROME_ENV_FILE:-}" ]; then
  printf '  env        source %s   (add to your shell rc for screenshots)\n' "$CHROME_ENV_FILE"
fi

# ------------------------------------------------------------------- verify
if [ "$VERIFY" = "1" ]; then
  echo "verify:"
  ok=1
  out="$(node "$FIRST_ROOT/naqsha/src/cli/naqsha.mjs" validate "$FIRST_ROOT/naqsha/examples/engine-repo.architecture.json" --json)" || ok=0
  printf '  validate   %s\n' "$(printf '%s' "$out" | head -c 160)"
  tmphtml="$(mktemp -d)/verify.html"
  out="$(node "$FIRST_ROOT/naqsha/src/cli/naqsha.mjs" render "$FIRST_ROOT/naqsha/examples/engine-repo.architecture.json" "$tmphtml" --json)" || ok=0
  printf '  render     %s\n' "$(printf '%s' "$out" | head -c 200)"
  if [ -f "$tmphtml" ]; then
    printf '  artifact   %s bytes\n' "$(wc -c < "$tmphtml" | tr -d ' ')"
  else
    ok=0
  fi
  if [ "$ok" = "1" ]; then echo "  RESULT     PASS"; else echo "  RESULT     FAIL"; exit 1; fi
fi

echo "done. skill name: naqsha — ask your agent: \"use naqsha to map this repo's architecture\""
