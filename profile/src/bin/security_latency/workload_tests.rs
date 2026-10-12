use super::*;

#[tokio::test(flavor = "current_thread")]
async fn legacy_corpus_pins_approval_floor_parent_resolution_and_symlink_outcomes() -> Result<()> {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    for enabled in [true, false] {
        let fixture = Fixture::new(&base, &Corpus::default(), enabled)?;
        let mut client = LegacyClient::new(&fixture);
        for row in ROWS {
            let actual = client.evaluate_observed(row).await;
            client.assert_correct(row, &actual);
        }
        assert_eq!(client.calls.host_public_calls, 9);
        assert!(
            !fixture.new_file.exists(),
            "benchmark must never execute writes"
        );
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn timed_evaluation_preserves_public_entry_bookkeeping_for_the_complete_corpus() -> Result<()>
{
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    for enabled in [true, false] {
        let fixture = Fixture::new(&base, &Corpus::default(), enabled)?;
        let mut client = LegacyClient::new(&fixture);
        client.calls.host_public_calls = 41;
        for row in ROWS {
            let actual = client.evaluate(row).await;
            client.assert_correct(row, &actual);
            assert_eq!(
                client.calls.host_public_calls,
                41,
                "{} enabled={enabled}",
                row.name()
            );
        }
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn untimed_observation_counts_actual_branches_without_changing_warmed_policy_or_fixtures(
) -> Result<()> {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    for enabled in [true, false] {
        let fixture = Fixture::new(&base, &Corpus::default(), enabled)?;
        let mut client = LegacyClient::new(&fixture);
        for row in ROWS {
            let warmed = client.evaluate(row).await;
            client.assert_correct(row, &warmed);
            // SecurityPolicy derives Debug over every field, including its
            // action tracker and canonical-workspace OnceCell.
            let policy_before = format!("{:?}", fixture.policy);
            let existing_before = std::fs::read(&fixture.existing)?;
            let outside_before = std::fs::read(&fixture.outside)?;
            let link_before = std::fs::read_link(fixture.escape.parent().unwrap())?;
            let calls_before = client.calls.host_public_calls;
            let observed = client.evaluate_observed(row).await;
            assert_eq!(observed, warmed, "{} enabled={enabled}", row.name());
            let expected_calls = match row {
                Row::ReadCommand | Row::WriteCommand => 2,
                _ => 1,
            };
            assert_eq!(
                client.calls.host_public_calls - calls_before,
                expected_calls
            );
            assert_eq!(format!("{:?}", fixture.policy), policy_before);
            assert_eq!(std::fs::read(&fixture.existing)?, existing_before);
            assert_eq!(std::fs::read(&fixture.outside)?, outside_before);
            assert_eq!(
                std::fs::read_link(fixture.escape.parent().unwrap())?,
                link_before
            );
            assert!(!fixture.new_file.exists());
            assert!(!fixture.new_file.parent().unwrap().exists());
            let repeated = client.evaluate(row).await;
            assert_eq!(repeated, observed);
            assert_eq!(
                client.calls.host_public_calls,
                calls_before + expected_calls
            );
        }
        assert_eq!(client.calls.host_public_calls, 9);
    }
    Ok(())
}

#[test]
fn configurable_corpus_rejects_fixture_escape_and_reserved_targets() {
    for path in [
        "../secret",
        "/etc/passwd",
        "x/../../y",
        ".ssh/key",
        "escape/file",
        "",
        "C:\\secret",
    ] {
        let corpus = Corpus {
            existing_file: path.into(),
            ..Corpus::default()
        };
        assert!(corpus.validate().is_err(), "accepted {path}");
    }
    assert!(Corpus {
        existing_file: "nested/read.txt".into(),
        new_file: "nested/new/file.txt".into(),
        outside_file: "external/read.txt".into()
    }
    .validate()
    .is_ok());
}

#[test]
fn omitted_corpus_fields_use_documented_fixture_defaults() -> Result<()> {
    let corpus: Corpus = serde_json::from_str(r#"{"existing_file":"custom/read.txt"}"#)?;
    assert_eq!(corpus.existing_file, "custom/read.txt");
    assert_eq!(corpus.new_file, Corpus::default().new_file);
    assert_eq!(corpus.outside_file, Corpus::default().outside_file);
    Ok(())
}
