use std::{
    fs::{self, File},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use nucleus_core::profiles::ProfileLaunch;
use nucleus_core::{CallbackCredential, Role, Run, Task};
use nucleus_store::StorageDirectory;
use serde::{Deserialize, Serialize};

use crate::ServiceError;

const DIRECTORY: &str = "report-tickets";

/// Owner-only callback envelope. Its credential must stay out of prompts and logs.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportTicket {
    pub task: String,
    pub instance: String,
    pub endpoint: String,
    pub credential: [u8; 32],
}

pub(crate) fn path(scratch: &StorageDirectory, instance: &str) -> PathBuf {
    scratch
        .path()
        .join(DIRECTORY)
        .join(format!("{instance}.json"))
}

pub(crate) fn prepare(
    scratch: &StorageDirectory,
    task: &Task,
    run: &Run,
    credential: &CallbackCredential,
    endpoint: &str,
) -> Result<(), ServiceError> {
    let instance = &run.launch().instance;
    let path = path(scratch, instance);
    let parent = path.parent().ok_or(ServiceError::Ticket)?;
    scratch.ensure_child(Path::new(DIRECTORY))?;
    if parent.metadata()?.permissions().mode() & 0o077 != 0 {
        return Err(ServiceError::Ticket);
    }
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(
        file.as_file_mut(),
        &ReportTicket {
            task: task.identity().id.clone(),
            instance: instance.clone(),
            endpoint: endpoint.into(),
            credential: *credential.as_bytes(),
        },
    )
    .map_err(|_| ServiceError::Ticket)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(&path).map_err(|_| ServiceError::Ticket)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

pub(crate) fn clear(scratch: &StorageDirectory, run: &Run) {
    if scratch.verify().is_ok() {
        let _ = fs::remove_file(path(scratch, &run.launch().instance));
    }
}

pub(crate) fn prompt(
    task: &Task,
    role: Role,
    review_head: Option<&str>,
    branch: &str,
    report_command: &Path,
    ticket: &Path,
    profile: Option<&ProfileLaunch>,
) -> String {
    let assignment = match role {
        Role::Worker => format!(
            "Implement the brief in this checkout. Commit to {branch}, push it and open a pull request against {}. Report the PR URL and full head SHA. Leave merge to the engine.",
            task.identity().base,
        ),
        Role::Reviewer => format!(
            "Review the pull request at commit {} in this checkout. Inspect changes and run focused checks. Leave the checkout clean and report approve or changes for that exact head with a short summary.",
            review_head.unwrap_or_default()
        ),
    };
    let report = match role {
        Role::Worker => {
            r#"{"work":{"url":"https://github.com/OWNER/REPO/pull/NUMBER","head":"FULL_SHA"}}"#
        }
        Role::Reviewer => {
            r#"{"review":{"head":"FULL_SHA","decision":"approve","summary":"SUMMARY"}} (use "changes" when revisions are needed)"#
        }
    };
    let question = r#"{"question":{"prompt":"QUESTION","options":["OPTION"]}}"#;
    let storage = ticket.parent().and_then(Path::parent).map_or_else(
        String::new,
        |scratch| {
            format!(
                " Set TMPDIR, TMP and TEMP to `{}` for commands. Set CARGO_TARGET_DIR to `{}` for Cargo.",
                scratch.display(),
                scratch.join("cargo-target").display(),
            )
        },
    );
    let mut prompt = format!(
        "{assignment}\n\nUse this task's checkout and repository only.{storage} Send {report} on stdin to the local CLI at {} with arguments `report --ticket` and ticket path {}. If you need a planning decision, send {question}. Keep the ticket contents private.\n\nBrief\n\n{}",
        report_command.display(),
        ticket.display(),
        task.brief().text
    );
    if let Some(profile) = profile
        && role == Role::Worker
        && let Some(pr) = profile.pull_request()
    {
        use std::fmt::Write as _;

        let _ = write!(
            prompt,
            "\n\nCurrent pull request\n{} at {}",
            pr.url, pr.head
        );
        if let Some(findings) = profile.findings() {
            let _ = write!(prompt, "\n\nApplied review findings\n{findings}");
        }
    }
    prompt
}
