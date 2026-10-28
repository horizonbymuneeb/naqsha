#!/usr/bin/env bash
# naqsha acceptance harness — see scripts/verify.mjs
#   ./verify.sh                                  # auto-detect Chrome
#   ./verify.sh --chrome /path/to/chrome --out /tmp/naqsha-verify
set -euo pipefail
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/verify.mjs" "$@"
