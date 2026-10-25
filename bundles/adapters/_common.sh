# Sourced by every adapter. The task container provides:
#   PROXY_URL (metering proxy)  DUMMY_API_KEY  BENCH_MODEL  BENCH_REASONING
#   PROMPT_FILE (task prompt)   cwd = the task's working directory
# Harnesses never see the real OpenRouter key; the proxy swaps credentials and
# pins model + reasoning on every request regardless of what the harness asks for.
set -euo pipefail
export PATH=/opt/harness/node/bin:$PATH
export HOME="${BENCH_HOME:-/tmp/bench-home}"
mkdir -p "$HOME"
PROMPT="$(cat "$PROMPT_FILE")"
WORKDIR_ABS="$(pwd)"
