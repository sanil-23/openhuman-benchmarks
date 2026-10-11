use crate::workload::{Corpus, Fixture, LegacyClient, ROWS};
use anyhow::{bail, ensure, Context, Result};
use serde::Serialize;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

fn nearest_rank(values: &mut [u64], percent: usize) -> u64 {
    assert!(!values.is_empty() && (1..=100).contains(&percent));
    values.sort_unstable();
    values[(percent * values.len()).div_ceil(100) - 1]
}

#[derive(Debug)]
struct Options {
    output: PathBuf,
    corpus: Corpus,
    enabled: bool,
    samples: usize,
    warmup: usize,
}
impl Options {
    fn parse(args: impl Iterator<Item = String>) -> Result<Self> {
        let mut result = Self {
            output: PathBuf::from(".security-evidence/legacy"),
            corpus: Corpus::default(),
            enabled: true,
            samples: 10_000,
            warmup: 1_000,
        };
        let mut args = args;
        while let Some(flag) = args.next() {
            let value = args.next().context("every argument needs a value")?;
            match flag.as_str() {
                "--output" => result.output = value.into(),
                "--corpus" => result.corpus = normalize_corpus(&std::fs::read(value)?)?,
                "--enabled" => result.enabled = value.parse()?,
                "--samples" => result.samples = value.parse()?,
                "--warmup" => result.warmup = value.parse()?,
                _ => bail!("unknown option {flag}; supported: --output --corpus --enabled --samples --warmup"),
            }
        }
        ensure!(
            result.samples > 0 && result.warmup > 0,
            "sample and warmup counts must be positive"
        );
        result.corpus.validate()?;
        Ok(result)
    }
}

#[derive(Serialize)]
struct Sample<'a> {
    row: &'a str,
    sample: usize,
    elapsed_ns: u64,
    decision: crate::workload::Decision,
    host_public_calls: u64,
}
#[derive(Serialize)]
struct Summary<'a> {
    row: &'a str,
    samples: usize,
    warmup: usize,
    p50_ns: u64,
    p99_ns: u64,
    host_public_calls: u64,
}
fn json_line(writer: &mut impl Write, value: &impl Serialize) -> Result<()> {
    serde_json::to_writer(&mut *writer, value)?;
    writer.write_all(b"\n")?;
    Ok(())
}
async fn run_with_reservation(options: Options, before_reservation: impl FnOnce()) -> Result<()> {
    if let Some(parent) = options
        .output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    // The test barrier synchronizes contenders immediately before the atomic
    // reservation; production uses a no-op outside the measured hot path.
    before_reservation();
    std::fs::create_dir(&options.output)
        .context("output reservation failed; preserve prior evidence")?;
    let mut raw = BufWriter::new(
        File::options()
            .write(true)
            .create_new(true)
            .open(options.output.join("samples.jsonl"))?,
    );
    let mut summaries = BufWriter::new(
        File::options()
            .write(true)
            .create_new(true)
            .open(options.output.join("summary.jsonl"))?,
    );
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/security-fixtures");
    let cold = Instant::now();
    let fixture = Fixture::new(&base, &options.corpus, options.enabled)?;
    let setup_ns = cold.elapsed().as_nanos();
    // Fixture and legacy policy creation is not native cold admission/registration.
    let mut receipt = File::options()
        .write(true)
        .create_new(true)
        .open(options.output.join("run.json"))?;
    receipt.write_all(&serde_json::to_vec_pretty(&serde_json::json!({
            "mode": "legacy_public_host", "enabled": options.enabled, "corpus": options.corpus,
        "built_host_pin": env!("SECURITY_BENCH_HOST_PIN"),
        "built_rustc": env!("SECURITY_BENCH_RUSTC"),
        "built_features": env!("SECURITY_BENCH_FEATURES"),
        "built_benchmarks_head": env!("SECURITY_BENCH_REPO_HEAD"),
        "built_benchmarks_status": env!("SECURITY_BENCH_REPO_STATUS"),
        "build_environment": {
            "profile": env!("SECURITY_BENCH_PROFILE"), "opt_level": env!("SECURITY_BENCH_OPT_LEVEL"),
            "debug": env!("SECURITY_BENCH_DEBUG"), "target": env!("SECURITY_BENCH_TARGET"),
            "host": env!("SECURITY_BENCH_HOST"), "encoded_rustflags": env!("SECURITY_BENCH_CARGO_ENCODED_RUSTFLAGS"),
            "rustflags": env!("SECURITY_BENCH_RUSTFLAGS"), "profile_environment_overrides": env!("SECURITY_BENCH_PROFILE_OVERRIDES"),
        },
        "compiled_sources": {
            "main.rs": include_str!("main.rs"), "harness.rs": include_str!("harness.rs"),
            "workload.rs": include_str!("workload.rs"),
            "Cargo.toml": include_str!("../../../Cargo.toml"),
            "Cargo.lock": include_str!("../../../Cargo.lock"),
            "build.rs": include_str!("../../../build.rs"),
        },
            "samples_per_row": options.samples, "warmup_per_row": options.warmup,
            "runtime": "tokio_current_thread", "runtime_workers": 1, "max_blocking_threads": 1, "release": !cfg!(debug_assertions),
            "fixture_and_policy_setup_ns": setup_ns, "native_cold_registration_ns": null,
            "bus_calls": null, "instrumentation": "public host API entries only; internal calls unobserved",
            "trusted_roots": [{"fixture_root": "action", "access": "readwrite"}],
            "reserved_roots": ["state", "synthetic-home/.ssh"], "forbidden_roots": ["state", "outside"]
        }))?)?;
    let mut client = LegacyClient::new(&fixture);
    let mut sweep_calls = 0;
    for row in ROWS {
        for _ in 0..options.warmup {
            let value = client.evaluate(row).await;
            client.assert_correct(row, &value);
        }
        let mut timings = Vec::with_capacity(options.samples);
        let mut row_calls = 0;
        for sample in 0..options.samples {
            let before = client.calls.host_public_calls;
            let start = Instant::now();
            let value = std::hint::black_box(client.evaluate(std::hint::black_box(row)).await);
            let elapsed_ns = u64::try_from(start.elapsed().as_nanos())?;
            client.assert_correct(row, &value);
            let host_public_calls = client.calls.host_public_calls - before;
            row_calls += host_public_calls;
            timings.push(elapsed_ns);
            json_line(
                &mut raw,
                &Sample {
                    row: row.name(),
                    sample,
                    elapsed_ns,
                    decision: value.0,
                    host_public_calls,
                },
            )?;
        }
        sweep_calls += row_calls;
        let p50_ns = nearest_rank(&mut timings, 50);
        let p99_ns = nearest_rank(&mut timings, 99);
        json_line(
            &mut summaries,
            &Summary {
                row: row.name(),
                samples: options.samples,
                warmup: options.warmup,
                p50_ns,
                p99_ns,
                host_public_calls: row_calls,
            },
        )?;
        println!(
            "legacy enabled={} row={} samples={} p50_ns={} p99_ns={} observed_host_public_calls={}",
            options.enabled,
            row.name(),
            options.samples,
            p50_ns,
            p99_ns,
            row_calls
        );
    }
    raw.flush()?;
    summaries.flush()?;
    println!("corpus_sweeps={} observed_host_public_calls={} (synthetic sweep, not a measured agent turn)", options.samples, sweep_calls);
    Ok(())
}

async fn run(options: Options) -> Result<()> {
    run_with_reservation(options, || {}).await
}

fn normalize_corpus(bytes: &[u8]) -> Result<Corpus> {
    let corpus: Corpus = serde_json::from_slice(bytes)?;
    corpus.validate()?;
    Ok(corpus)
}

pub fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if let [flag, path] = args.as_slice() {
        if flag == "--describe-corpus" {
            // Configuration only: no fixture, policy call, execution or timing.
            println!(
                "{}",
                serde_json::to_string(&normalize_corpus(&std::fs::read(path)?)?)?
            );
            return Ok(());
        }
    }
    let options = Options::parse(args.into_iter())?;
    tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()?
        .block_on(run(options))
}

#[cfg(test)]
#[path = "harness_tests.rs"]
mod tests;
