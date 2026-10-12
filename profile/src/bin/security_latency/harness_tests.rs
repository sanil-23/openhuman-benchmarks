use super::*;

#[test]
fn percentiles_use_nearest_rank_even_for_short_or_unsorted_runs() {
    assert_eq!(nearest_rank(&mut [99, 1, 4, 3], 50), 3);
    assert_eq!(nearest_rank(&mut [99, 1, 4, 3], 99), 99);
    assert_eq!(nearest_rank(&mut [7], 50), 7);
    let mut samples: Vec<u64> = (1..=10000).rev().collect();
    assert_eq!(nearest_rank(&mut samples, 50), 5000);
    assert_eq!(nearest_rank(&mut samples, 99), 9900);
}

#[tokio::test(flavor = "current_thread")]
async fn output_retains_individual_samples_and_observed_counts_for_every_row() -> Result<()> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    std::fs::create_dir_all(&base)?;
    let directory = tempfile::tempdir_in(base)?;
    for enabled in [true, false] {
        let output = directory.path().join(format!("run-{enabled}"));
        run(Options {
            output: output.clone(),
            corpus: Corpus::default(),
            enabled,
            samples: 3,
            warmup: 1,
        })
        .await?;
        let raw: Vec<serde_json::Value> = std::fs::read_to_string(output.join("samples.jsonl"))?
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(raw.len(), 21);
        assert_eq!(
            raw.iter()
                .map(|row| row["host_public_calls"].as_u64().unwrap())
                .sum::<u64>(),
            27
        );
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(output.join("run.json"))?)?;
        assert_eq!(receipt["untimed_observations_per_row"], 3);
        assert_eq!(receipt["workload_evaluations_per_row"], 7);
        for sample in &raw {
            let expected_calls = match sample["row"].as_str().unwrap() {
                "allowed_read_command" | "write_requires_approval" => 2,
                _ => 1,
            };
            assert_eq!(sample["host_public_calls"], expected_calls);
        }
        let summary: Vec<serde_json::Value> =
            std::fs::read_to_string(output.join("summary.jsonl"))?
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        assert_eq!(summary.len(), 7);
        for row in summary {
            let mut times: Vec<u64> = raw
                .iter()
                .filter(|sample| sample["row"] == row["row"])
                .map(|sample| sample["elapsed_ns"].as_u64().unwrap())
                .collect();
            times.sort_unstable();
            assert_eq!(row["p50_ns"], times[1]);
            assert_eq!(row["p99_ns"], times[2]);
        }
    }
    Ok(())
}

#[test]
fn invalid_counts_and_unknown_modes_cannot_masquerade_as_baseline() {
    for args in [
        vec!["--samples", "0"],
        vec!["--warmup", "0"],
        vec!["--mode", "native"],
    ] {
        assert!(Options::parse(args.into_iter().map(String::from)).is_err());
    }
}

#[tokio::test(flavor = "current_thread")]
async fn existing_evidence_is_preserved_instead_of_overwritten() -> Result<()> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    std::fs::create_dir_all(&base)?;
    let directory = tempfile::tempdir_in(base)?;
    let sentinel = directory.path().join("samples.jsonl");
    std::fs::write(&sentinel, "prior baseline")?;
    let result = run(Options {
        output: directory.path().into(),
        corpus: Corpus::default(),
        enabled: true,
        samples: 1,
        warmup: 1,
    })
    .await;
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(sentinel)?, "prior baseline");
    Ok(())
}

#[test]
fn concurrent_runs_reserve_one_output_and_preserve_the_winning_receipt() -> Result<()> {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    std::fs::create_dir_all(&base)?;
    let directory = tempfile::tempdir_in(base)?;
    let output = directory.path().join("concurrent");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let results = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let output = output.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    tokio::runtime::Builder::new_current_thread()
                        .max_blocking_threads(1)
                        .enable_all()
                        .build()
                        .unwrap()
                        .block_on(run_with_reservation(
                            Options {
                                output,
                                corpus: Corpus::default(),
                                enabled: true,
                                samples: 3,
                                warmup: 1,
                            },
                            || {
                                barrier.wait();
                            },
                        ))
                        .is_ok()
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(
        results.into_iter().filter(|won| *won).count(),
        1,
        "exactly one concurrent run must win"
    );
    let raw = std::fs::read(output.join("samples.jsonl"))?;
    let summary = std::fs::read(output.join("summary.jsonl"))?;
    let receipt = std::fs::read(output.join("run.json"))?;
    assert_eq!(String::from_utf8(raw.clone())?.lines().count(), 21);
    assert!(tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(run(Options {
            output: output.clone(),
            corpus: Corpus::default(),
            enabled: false,
            samples: 1,
            warmup: 1
        }))
        .is_err());
    assert_eq!(std::fs::read(output.join("samples.jsonl"))?, raw);
    assert_eq!(std::fs::read(output.join("summary.jsonl"))?, summary);
    assert_eq!(std::fs::read(output.join("run.json"))?, receipt);
    Ok(())
}

#[test]
fn corpus_description_normalizes_defaults_and_rejects_unsafe_fixture_targets() -> Result<()> {
    let corpus = normalize_corpus(br#"{"existing_file":"nested/read.txt"}"#)?;
    let described = serde_json::to_value(&corpus)?;
    assert_eq!(described["existing_file"], "nested/read.txt");
    assert_eq!(described["new_file"], "new/deep/file.txt");
    assert_eq!(described["outside_file"], "outside.txt");
    assert!(normalize_corpus(br#"{"existing_file":"../escaped"}"#).is_err());
    assert!(normalize_corpus(br#"{"unknown":"value"}"#).is_err());
    Ok(())
}
