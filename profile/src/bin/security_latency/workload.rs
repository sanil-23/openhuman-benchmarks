use anyhow::{ensure, Result};
use openhuman_core::security::{
    AutonomyLevel, GateDecision, SecurityPolicy, TrustedAccess, TrustedRoot,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Fixture-relative corpus. Commands are fixed classifier inputs: never executed.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Corpus {
    pub existing_file: String,
    pub new_file: String,
    pub outside_file: String,
}
impl Default for Corpus {
    fn default() -> Self {
        Self {
            existing_file: "existing.txt".into(),
            new_file: "new/deep/file.txt".into(),
            outside_file: "outside.txt".into(),
        }
    }
}
impl Corpus {
    pub fn validate(&self) -> Result<()> {
        for value in [&self.existing_file, &self.new_file, &self.outside_file] {
            ensure!(
                !value.is_empty() && !value.contains('\0') && !value.contains('\\'),
                "fixture paths must be nonempty relative paths"
            );
            ensure!(
                Path::new(value)
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))),
                "fixture paths cannot escape their roots"
            );
            ensure!(
                !value
                    .split('/')
                    .any(|c| matches!(c, ".ssh" | ".aws" | ".gnupg" | "escape")),
                "reserved fixture component"
            );
        }
        ensure!(
            self.existing_file != self.new_file
                && !self
                    .new_file
                    .starts_with(&(self.existing_file.clone() + "/")),
            "new-file fixture must stay nonexistent"
        );
        Ok(())
    }
}

pub struct Fixture {
    _directory: tempfile::TempDir,
    pub policy: SecurityPolicy,
    existing: PathBuf,
    new_file: PathBuf,
    outside: PathBuf,
    escape: PathBuf,
    credential_command: String,
}
impl Fixture {
    pub fn new(base: &Path, corpus: &Corpus, enabled: bool) -> Result<Self> {
        corpus.validate()?;
        std::fs::create_dir_all(base)?;
        let directory = tempfile::Builder::new()
            .prefix("security-")
            .tempdir_in(base)?;
        let root = directory.path().canonicalize()?;
        let action = root.join("action");
        let state = root.join("state");
        let outside_root = root.join("outside");
        let home = root.join("synthetic-home");
        for path in [&action, &state, &outside_root, &home.join(".ssh")] {
            std::fs::create_dir_all(path)?;
        }
        let existing = action.join(&corpus.existing_file);
        let outside = outside_root.join(&corpus.outside_file);
        for file in [&existing, &outside] {
            std::fs::create_dir_all(file.parent().unwrap())?;
            std::fs::write(file, b"synthetic fixture")?;
        }
        let new_file = action.join(&corpus.new_file);
        ensure!(!new_file.exists(), "new-file row must not exist");
        let link = action.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside_root, &link)?;
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside_root, &link)?;
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("symlink workload unsupported on this platform");
        let escape = link.join(&corpus.outside_file);
        let credential_command = format!("cat {}", home.join(".ssh/key").display());
        let policy = SecurityPolicy {
            enabled,
            autonomy: AutonomyLevel::Supervised,
            action_dir: action.clone(),
            workspace_dir: state.clone(),
            workspace_only: true,
            trusted_roots: vec![TrustedRoot {
                path: action.to_string_lossy().into_owned(),
                access: TrustedAccess::ReadWrite,
            }],
            forbidden_paths: vec![
                state.to_string_lossy().into_owned(),
                outside_root.to_string_lossy().into_owned(),
            ],
            ..SecurityPolicy::default()
        };
        Ok(Self {
            _directory: directory,
            policy,
            existing,
            new_file,
            outside,
            escape,
            credential_command,
        })
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    RequireApproval,
    Deny,
}
#[derive(Clone, Copy, Debug)]
pub enum Row {
    ReadCommand,
    WriteCommand,
    CredentialCommand,
    ExistingFile,
    NewFileParent,
    OutsideRoot,
    SymlinkEscape,
}
pub const ROWS: [Row; 7] = [
    Row::ReadCommand,
    Row::WriteCommand,
    Row::CredentialCommand,
    Row::ExistingFile,
    Row::NewFileParent,
    Row::OutsideRoot,
    Row::SymlinkEscape,
];
impl Row {
    pub fn name(self) -> &'static str {
        match self {
            Self::ReadCommand => "allowed_read_command",
            Self::WriteCommand => "write_requires_approval",
            Self::CredentialCommand => "credential_command_floor",
            Self::ExistingFile => "allowed_existing_file",
            Self::NewFileParent => "new_file_parent",
            Self::OutsideRoot => "outside_root",
            Self::SymlinkEscape => "symlink_escape",
        }
    }
    pub fn expected(self, enabled: bool) -> Decision {
        match self {
            Self::CredentialCommand => Decision::Deny,
            Self::WriteCommand if enabled => Decision::RequireApproval,
            Self::OutsideRoot | Self::SymlinkEscape if enabled => Decision::Deny,
            _ => Decision::Allow,
        }
    }
}

/// Counts instrumented public API entries only; internal policy calls are unobserved.
#[derive(Default, Debug, Serialize, PartialEq, Eq)]
pub struct Calls {
    pub host_public_calls: u64,
}
/// Public-host boundary. A future native adapter must implement this same workload
/// using released bus contracts and measure its actual dispatches independently.
/// This legacy-only pin does not expose or implement a native measurement mode.
pub struct LegacyClient<'a> {
    fixture: &'a Fixture,
    pub calls: Calls,
}
impl<'a> LegacyClient<'a> {
    pub fn new(fixture: &'a Fixture) -> Self {
        Self {
            fixture,
            calls: Calls::default(),
        }
    }
    pub async fn evaluate(&mut self, row: Row) -> (Decision, Option<PathBuf>) {
        let policy = &self.fixture.policy;
        match row {
            Row::ReadCommand | Row::WriteCommand | Row::CredentialCommand => {
                let command = match row {
                    Row::ReadCommand => "ls",
                    Row::WriteCommand => "printf benchmark > benchmark.txt",
                    _ => &self.fixture.credential_command,
                };
                self.calls.host_public_calls += 1;
                let Ok(class) = policy.check_gated_command(command) else {
                    return (Decision::Deny, None);
                };
                self.calls.host_public_calls += 1;
                let decision = match policy.gate_decision(class) {
                    GateDecision::Allow => Decision::Allow,
                    GateDecision::Prompt => Decision::RequireApproval,
                    GateDecision::Block => Decision::Deny,
                };
                (decision, None)
            }
            _ => {
                self.calls.host_public_calls += 1;
                let path = match row {
                    Row::ExistingFile => &self.fixture.existing,
                    Row::NewFileParent => &self.fixture.new_file,
                    Row::OutsideRoot => &self.fixture.outside,
                    Row::SymlinkEscape => &self.fixture.escape,
                    _ => unreachable!(),
                };
                let path = path.to_str().expect("UTF-8 fixture path");
                let result = if matches!(row, Row::NewFileParent) {
                    policy.validate_parent_path(path).await
                } else {
                    policy.validate_path(path).await
                };
                match result {
                    Ok(path) => (Decision::Allow, Some(path)),
                    Err(_) => (Decision::Deny, None),
                }
            }
        }
    }
    pub fn assert_correct(&self, row: Row, actual: &(Decision, Option<PathBuf>)) {
        assert_eq!(
            actual.0,
            row.expected(self.fixture.policy.enabled),
            "{}",
            row.name()
        );
        let expected_path = match row {
            Row::ExistingFile => Some(self.fixture.existing.clone()),
            Row::NewFileParent => Some(self.fixture.new_file.clone()),
            Row::OutsideRoot | Row::SymlinkEscape if !self.fixture.policy.enabled => {
                Some(self.fixture.outside.clone())
            }
            _ => None,
        };
        assert_eq!(actual.1, expected_path, "{} resolved target", row.name());
    }
}

#[cfg(test)]
#[path = "workload_tests.rs"]
mod tests;
