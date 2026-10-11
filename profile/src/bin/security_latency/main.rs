//! Offline legacy public-host security validation benchmark. No commands execute.
//!
//! Build from the benchmarks root (run long builds through the host's
//! `scripts/ci-cancel-aware.sh`):
//! `cargo +1.99.0 build --offline --locked --release --manifest-path profile/Cargo.toml
//! --no-default-features --bin security-latency-bench`.
//! Then, on a quiet Linux machine (the quiet observer uses `/proc`):
//! `python3 profile/scripts/security-latency.py
//! --binary profile/target/release/security-latency-bench
//! --build-log .security-evidence/release-build.log`. Use `--verbose` when building
//! to preserve compiler parameters in a supplied log. That log is explicitly
//! unverified against the executable; compile-emitted environment is separate.
//! Requested manifest
//! settings are labelled separately from captured build environment/arguments.
//! The runner uses five independent processes for each enabled/disabled variant,
//! 1,000 warmups and 10,000 samples per row. Preserve its complete output directory.
//!
//! Optional `--corpus path.json` configures three fixture-relative targets:
//! `existing_file`, `new_file`, `outside_file`. Omitted targets use the documented
//! default corpus in `workload.rs`. The runner captures the caller input once in
//! its reserved evidence directory and asks this binary `--describe-corpus` to
//! normalize it without any policy call or timing. Every repetition receives the
//! same snapshot and must report the frozen normalized workload verbatim. All roots remain disposable checkout-local
//! fixtures; protected credential data is synthetic. No operator config loads.
//! Each repetition contains raw JSONL, nearest-rank p50/p99 summaries, and setup
//! timing separately. Policy creation/fixture setup is not native registration.
//!
//! Measured legacy boundary: check_gated_command plus gate_decision for accepted
//! commands, check_gated_command alone for denial, validate_path for reads, and
//! validate_parent_path for new writes. Correctness checks and JSON serialization
//! are outside the measured interval. Instrumentation counts these actual public
//! entries; internal policy calls and bus calls are unobserved, not inferred.
//! The seven-row sweep is a synthetic workload, not an observed agent turn.
//!
//! Native extension is deliberately unavailable at this immutable host pin,
//! which has no TinySecurity contract. Add a separate native client only after
//! the immutable 0.3 module is published and a canonical host pin exposes its
//! implemented bus contract. Load only that verified release artifact through
//! TinyBus; link only bus contracts, never TinySecurity implementation. Preserve
//! this original legacy baseline and corpus. Future native outputs must distinguish
//! cold admission/registration, warmed direct dispatch and full public-host calls,
//! record artifact SHA256, and count actual dispatches per row/turn. No mock-bus
//! or changing development artifact may be labelled the released-module baseline.
mod harness;
mod workload;
fn main() -> anyhow::Result<()> {
    harness::main()
}
