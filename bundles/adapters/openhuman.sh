#!/usr/bin/env bash
. "$(dirname "$0")/_common.sh"
# Loopback hop to the metering proxy (see forward.mjs): its unix socket when PROXY_SOCKET is
# set (Harbor), else PROXY_URL on the bench network.
if [ -n "${PROXY_SOCKET:-}" ]; then
  node /opt/harness/forward.mjs 18080 "$PROXY_SOCKET" &
else
  proxy_host="${PROXY_URL#http://}"; proxy_host="${proxy_host%%:*}"
  proxy_port="${PROXY_URL##*:}"
  node /opt/harness/forward.mjs 18080 "$proxy_host" "$proxy_port" &
fi
fwd=$!
for _ in $(seq 1 50); do (echo > /dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done

# Provider-native structured tool calls (JSON tool schemas in the API `tools` field), like
# the other harnesses. The product's older `python` text dispatcher leaked tool calls into
# the reply on this model, so it is not what this benchmark measures.
export OPENHUMAN_TOOL_DISPATCHER=native
# No Composio account in the bench: skip the hosted integrations fetch (a 401 on the
# dummy key) that otherwise sits on the first turn's critical path.
export OPENHUMAN_COMPOSIO_MODE=disabled
# The task container is the isolation boundary (as for every other harness). OpenHuman's own OS
# jail (Landlock) would confine the shell to the action dir, so installs into site-packages,
# /etc edits and even listing / are refused as root. Turn it off (openhuman OPENHUMAN_SANDBOX).
export OPENHUMAN_SANDBOX=off
export OPENHUMAN_WORKSPACE="$HOME/oh-workspace"
export OPENHUMAN_ACTION_DIR="$WORKDIR_ABS"
mkdir -p "$OPENHUMAN_WORKSPACE"
# Turn the memory engine off. `has_api_key` tests only that a key is *present*
# (`key.is_some()`), so the dummy credential below makes the hosted TinyHumans
# engine look usable and `tools::ops` registers the `memory` tool -- a tool that
# can only fail here. When the model reaches for it the 401 is a tool failure of
# class `authentication`, and ONE of those aborts the whole turn:
# terminal-bench 4.0 `payments-pipeline-fix` stopped on
# "failure class `authentication` still blocks operation `memory`" with 22h of
# its budget unused, having spent only 27 calls. It is latent in every run --
# all five runs inspected were offered the tool -- and fires whenever the model
# happens to pick it, so it is a variance source across the whole suite.
#
# An empty engine id is the supported off switch (memory/engine.rs `resolve`:
# `"" => off(..., "no memory engine selected")`), and there is no env override
# for it, so it goes in the config the workspace resolves to. Memory should be
# off here regardless: every peer harness is stateless, each task gets a fresh
# container, and the lifecycle hooks would recall against an empty engine
# anyway. The hooks themselves are fail-soft (pre_turn/post_turn/compaction all
# swallow the error and let the turn run). The benchmark also disables the
# embedder and both lifecycle hooks, then verifies the runtime state before inference.
# Web search is off: the bench configures no search provider, so every
# `web_search_tool` call came back `provider returned HTTP 401`. The model
# reached for it in 4 of the first 38 Terminal-Bench 2.0 tasks and, until the
# breaker learned to steer off a refused connector, each of those turns ended
# there (build-pov-ray after 69 s of a 3 h 20 m budget). A tool that cannot
# work is not part of the agent being measured; the task containers keep
# their internet, so `shell` can still fetch what a task needs.
if [ ! -f "$OPENHUMAN_WORKSPACE/config.toml" ]; then
  # `runtime.reasoning_effort` makes the harness declare the effort the run is
  # pinned to (the meter-proxy still pins the wire), so every request carries a
  # thinking budget (`reasoning.budget_tokens`, 55% of the turn's output cap).
  # The routable providers ignore that budget; tinyagents' reasoning watchdog
  # enforces it client-side and ends a call that reasons past it with nothing
  # visible, instead of waiting for the output cap.
  # Web search is on only when a direct search provider's key reached this
  # container (`BENCH_AGENT_ENV=EXA_API_KEY` on the runner); the harness's env
  # overlay configures that provider from the key. Without one the tool would
  # answer 401 on every call, so it stays off.
  search_enabled=false
  if [ -n "${EXA_API_KEY:-}" ] || [ -n "${OPENHUMAN_EXA_API_KEY:-}" ]; then
    search_enabled=true
    # Route the provider directly: the config migration otherwise routes exa
    # through the managed backend, which needs a signed-in user and answers
    # 401 here (measured: 27 of 27 searches failed in 1 ms on the first run).
    export OPENHUMAN_SEARCH_PROVIDERS="${OPENHUMAN_SEARCH_PROVIDERS:-exa:direct}"
    export OPENHUMAN_SEARCH_ENABLED="${OPENHUMAN_SEARCH_ENABLED:-true}"
  elif [ -n "${BRAVE_API_KEY:-}" ]; then
    search_enabled=true
    export OPENHUMAN_SEARCH_PROVIDERS="${OPENHUMAN_SEARCH_PROVIDERS:-brave:direct}"
    export OPENHUMAN_SEARCH_ENABLED="${OPENHUMAN_SEARCH_ENABLED:-true}"
  elif [ -n "${TAVILY_API_KEY:-}" ]; then
    search_enabled=true
    export OPENHUMAN_SEARCH_PROVIDERS="${OPENHUMAN_SEARCH_PROVIDERS:-tavily:direct}"
    export OPENHUMAN_SEARCH_ENABLED="${OPENHUMAN_SEARCH_ENABLED:-true}"
  fi
  printf 'embeddings_provider = "none"\n\n[memory]\nengine = ""\nembedding_provider = "none"\n\n[memory.recall]\nenabled = false\n\n[memory.conversations]\nenabled = false\n\n[search]\nenabled = %s\n\n[runtime]\nreasoning_effort = "%s"\n' "$search_enabled" "${BENCH_REASONING:-high}" > "$OPENHUMAN_WORKSPACE/config.toml"
fi
# The core needs *a* credential before it will run a turn even on a BYOK route;
# a dummy API key satisfies that without granting any backend access, and
# inference itself goes to the metering proxy through the per-call route.
export OPENHUMAN_BACKEND_API_KEY="${OPENHUMAN_BACKEND_API_KEY:-$DUMMY_API_KEY}"
# Each task has an ephemeral workspace and no OS keyring. Keep credential storage
# encrypted with a fresh master key unless the caller supplied a key source.
if [ -z "${OPENHUMAN_KEYRING_MASTER_KEY:-}" ] && [ -z "${OPENHUMAN_KEYRING_MASTER_KEY_FILE:-}" ]; then
  export OPENHUMAN_KEYRING_MASTER_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
fi
export OPENHUMAN_KEYRING_BACKEND=encrypted_file

# The module loader admits a module directory only if it and every ancestor is
# owned by the current user or root (tinybus `check_directory`). The bundle is
# bind-mounted owned by the host user who built it, while task images run as
# root, so every loadable module (tinyruntime, tinysearch, ...) was refused with
# "module directory is owned by another user". Stage a root-owned copy instead.
bundled=/opt/harness/openhuman/bundled-modules
if [ -d "$bundled" ] && [ "$(id -u)" != "$(stat -c %u "$bundled")" ]; then
  staged=/opt/oh-bundled-modules
  rm -rf "$staged"
  cp -r "$bundled" "$staged"
  chmod -R go-w "$staged"
  export OPENHUMAN_BUNDLED_MODULES="$staged"
  echo "[openhuman] staged bundled modules owned by uid $(id -u): $staged" >&2
fi
# A bundle built with LOCAL_MODULES=tinyjuice carries a locally built TinyJuice module; load it
# through the core's developer override instead of the pinned release (root-owned copy, as above).
dev_juice=/opt/harness/openhuman/dev-modules/libtinyjuice_module.so
if [ -f "$dev_juice" ]; then
  mkdir -p /opt/oh-dev-modules && cp "$dev_juice" /opt/oh-dev-modules/ && chmod -R go-w /opt/oh-dev-modules
  export TINYJUICE_TEST_MODULE=/opt/oh-dev-modules/libtinyjuice_module.so
  echo "[openhuman] TinyJuice module override: $TINYJUICE_TEST_MODULE" >&2
fi
# The shell tool puts a resolved Python first on PATH for `python`/`pip` commands.
# By default that is a downloaded standalone CPython, which lacks the task repo's
# installed dependencies. Use the task image's own interpreter, as every other
# harness does.
export OPENHUMAN_RUNTIME_PYTHON_PREFER_SYSTEM=1
export OPENHUMAN_RUNTIME_PYTHON_MINIMUM_VERSION=3.0.0

# Headless core, the way a product host runs it; the turn goes over JSON-RPC.
export OH_PORT=7788 OH_TOKEN=bench-core-token OPENHUMAN_CORE_TOKEN=bench-core-token
# BENCH_PROXY_PREFIX (/__tag/<run>/<harness>/<task>) tags each call for the proxy, so trials can
# run side by side; without it the proxy's global tag applies.
export INFERENCE_URL="http://127.0.0.1:18080${BENCH_PROXY_PREFIX:-}/v1"
# Why the core's own log is kept: the JSON-RPC reply carries the harness's
# SANITIZED failure string. `HostedError.message` is "a fixed, sanitized string
# selected by `kind`" and never the underlying provider/middleware error, so a
# failed turn reaches the bench as `model error: hosted agent invocation failed`
# and nothing else. An `atrx-vep-crispr` turn burned 91 minutes and 176 model
# calls and left no recorded reason at all. The real cause IS logged -- the
# re-surfacing path in `turn_run_error.rs` logs it at debug -- but the log died
# with the container. Scope the filter to our own crates so third-party noise
# does not bury it, and copy it out beside the other artifacts.
export RUST_LOG="${RUST_LOG:-warn,openhuman=debug,tinyagents=debug,tinyagents_harness=debug}"
# Write directly to the mounted result dir so SIGKILL cannot lose the log.
core_log="${RESULT_DIR:-/results}/core.log"
/opt/harness/openhuman/openhuman-core run --headless-api --host 127.0.0.1 --port "$OH_PORT" \
  > "$core_log" 2>&1 &
core=$!
trap 'kill $core $fwd 2>/dev/null || true' EXIT
node /opt/harness/oh-turn.mjs
