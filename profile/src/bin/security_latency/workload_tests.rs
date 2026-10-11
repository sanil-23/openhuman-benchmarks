use super::*;

#[tokio::test(flavor = "current_thread")]
async fn legacy_corpus_pins_approval_floor_parent_resolution_and_symlink_outcomes() -> Result<()> {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/security-test-fixtures");
    for enabled in [true, false] {
        let fixture = Fixture::new(&base, &Corpus::default(), enabled)?;
        let mut client = LegacyClient::new(&fixture);
        for row in ROWS {
            let actual = client.evaluate(row).await;
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
