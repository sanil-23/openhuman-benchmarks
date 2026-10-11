#!/usr/bin/env bash
# Build a harness bundle and extract it to .cache/harness/<name>/.
#   ./bundles/build.sh claude-code|codex|opencode|openclaw|hermes|openhuman
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# The OpenHuman bundle compiles the vendored checkout (git submodule vendor/openhuman).
# OPENHUMAN_SRC=<checkout> builds another tree instead (e.g. a feature worktree under test).
# BUNDLE_NAME=<name> extracts to .cache/harness/<name>/ instead of .cache/harness/<harness>/, so a
# build under test does not replace the bundle another checkout sharing .cache is running.
repo="${OPENHUMAN_SRC:-$here/vendor/openhuman}"
name="${1:?usage: build.sh <harness>}"
args=()
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" == \#* ]] && continue
  args+=(--build-arg "$k=$v")
done < "$here/harnesses.lock"

# BUNDLE_NAME extracts (and tags) the bundle under another name, so a variant can be built and
# run (HARNESS_BUNDLE=<name>) without replacing the bundle another run is using.
image="bench-bundle-${BUNDLE_NAME:-$name}"
# The bundle is bind-mounted into the task container and must match ITS
# architecture, not the build host's. Terminal-Bench images are amd64-only, so
# on an arm64 host (including a Rosetta-backed Lima/Colima VM, which *runs*
# amd64 but *builds* native aarch64) an unpinned `docker build` produces a
# bundle the task cannot execute. The only symptom is the bench entry exiting
# 127 with empty stderr, which says nothing about why.
platform="${BENCH_BUNDLE_PLATFORM:-linux/amd64}"
case "$name" in
  openhuman)
    if [ ! -f "$repo/Cargo.toml" ]; then
      echo "$repo is not an OpenHuman checkout (vendor/openhuman not initialized?): git submodule update --init --recursive vendor/openhuman" >&2
      exit 1
    fi
    # The build context is the OpenHuman tree; adapters come from this repo via a named context.
    docker build -f "$here/bundles/Dockerfile.openhuman" \
      --platform "$platform" \
      --build-context "bench=$here/bundles" \
      --build-arg "ADAPTER=adapters/$name.sh" \
      --build-arg "GIT_SHA=$(git -C "$repo" rev-parse --short HEAD)" \
      --build-arg "LOCAL_MODULES=${LOCAL_MODULES:-}" \
      --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-4}" \
      -t "$image" "$repo"
    ;;
  deepseek-harness-minimal)
    # Same install as deepseek-harness; only the adapter (profile) differs.
    image="bench-bundle-deepseek-harness"
    docker build -f "$here/bundles/Dockerfile" --platform "$platform" --target deepseek-harness "${args[@]}" -t "$image" "$here/bundles"
    ;;
  *)
    docker build -f "$here/bundles/Dockerfile" --platform "$platform" --target "$name" "${args[@]}" -t "$image" "$here/bundles"
    ;;
esac

out="$here/.cache/harness/${BUNDLE_NAME:-$name}"
rm -rf "$out"; mkdir -p "$out"
cid="$(docker create "$image" /bin/true)"
trap 'docker rm -f "$cid" >/dev/null' EXIT
docker cp "$cid:/opt/harness/." "$out/"
if [ "$name" = deepseek-harness-minimal ]; then
  cp "$here/bundles/adapters/deepseek-harness-minimal.sh" "$out/adapter.sh"
fi
chmod +x "$out/adapter.sh"

# Fail loudly here rather than as `exit 127` inside a task 30 minutes later.
# (a plain case: bash 3.2 cannot parse a `case` inside `$(...)` and fails after the image is built)
case "$platform" in
  */amd64) want=x86-64 ;;
  */arm64|*/aarch64) want=aarch64 ;;
  *) want="" ;;
esac
if [ -n "$want" ] && [ -x "$out/node/bin/node" ]; then
  got="$(file -b "$out/node/bin/node")"
  case "$got" in
    *"$want"*) ;;
    *)
      echo "bundle arch mismatch: wanted $want for $platform, built $got" >&2
      echo "the task container cannot execute this bundle; rebuild with BENCH_BUNDLE_PLATFORM=$platform" >&2
      exit 1
      ;;
  esac
fi
echo "bundle ready: $out ($(du -sh "$out" | cut -f1), $platform)"
