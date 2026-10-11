//! Exports `OPENHUMAN_REPOSITORY_ROOT` (the vendored checkout) for
//! `tool-search-bench`, which reads openhuman's recorded Composio catalogues
//! from `tests/fixtures/` there.
use std::path::Path;

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let root = Path::new(&manifest).join("../vendor/openhuman");
    let root = root.canonicalize().unwrap_or(root);
    println!(
        "cargo:rustc-env=OPENHUMAN_REPOSITORY_ROOT={}",
        root.display()
    );
    let rustc = std::process::Command::new(std::env::var("RUSTC").expect("RUSTC"))
        .arg("-Vv")
        .output()
        .expect("rustc version");
    assert!(rustc.status.success());
    println!(
        "cargo:rustc-env=SECURITY_BENCH_RUSTC={}",
        String::from_utf8(rustc.stdout)
            .expect("UTF-8 rustc")
            .replace('\n', " | ")
    );
    let host_pin = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(&root)
        .output()
        .expect("host pin");
    assert!(host_pin.status.success());
    println!(
        "cargo:rustc-env=SECURITY_BENCH_HOST_PIN={}",
        String::from_utf8(host_pin.stdout)
            .expect("UTF-8 host pin")
            .trim()
    );
    let mut features: Vec<_> = std::env::vars()
        .filter_map(|(key, _)| key.strip_prefix("CARGO_FEATURE_").map(str::to_owned))
        .collect();
    features.sort();
    println!(
        "cargo:rustc-env=SECURITY_BENCH_FEATURES={}",
        features.join(",")
    );
    println!("cargo:rerun-if-changed=../vendor/openhuman");
    for key in [
        "PROFILE",
        "OPT_LEVEL",
        "DEBUG",
        "TARGET",
        "HOST",
        "CARGO_ENCODED_RUSTFLAGS",
        "RUSTFLAGS",
    ] {
        println!(
            "cargo:rustc-env=SECURITY_BENCH_{key}={}",
            std::env::var(key).unwrap_or_default().replace('\n', "\\n")
        );
    }
    let mut overrides: Vec<_> = std::env::vars()
        .filter(|(key, _)| key.starts_with("CARGO_PROFILE_RELEASE_"))
        .collect();
    overrides.sort();
    println!(
        "cargo:rustc-env=SECURITY_BENCH_PROFILE_OVERRIDES={}",
        overrides
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join(" | ")
    );
    let bench_root = Path::new(&manifest).parent().expect("benchmark root");
    for (name, args) in [
        ("HEAD", vec!["rev-parse", "HEAD"]),
        (
            "STATUS",
            vec!["status", "--porcelain", "--untracked-files=normal"],
        ),
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(bench_root)
            .output()
            .expect("benchmark source identity");
        assert!(output.status.success());
        println!(
            "cargo:rustc-env=SECURITY_BENCH_REPO_{name}={}",
            String::from_utf8(output.stdout)
                .expect("UTF-8 identity")
                .trim()
                .replace('\n', " | ")
        );
    }
    let index = std::process::Command::new("git")
        .args(["rev-parse", "--git-path", "index"])
        .current_dir(bench_root)
        .output()
        .expect("git index path");
    assert!(index.status.success());
    let index = String::from_utf8(index.stdout).expect("UTF-8 git index");
    println!(
        "cargo:rerun-if-changed={}",
        bench_root.join(index.trim()).display()
    );
    println!("cargo:rerun-if-changed=build.rs");
}
