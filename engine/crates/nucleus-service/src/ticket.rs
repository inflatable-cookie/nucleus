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

pub(crate) struct PromptPaths<'a> {
    pub command: &'a Path,
    pub ticket: &'a Path,
    pub builds: &'a Path,
}

pub(crate) fn prompt(
    task: &Task,
    role: Role,
    review_head: Option<&str>,
    branch: &str,
    paths: &PromptPaths<'_>,
    profile: Option<&ProfileLaunch>,
) -> String {
    let storage = paths.ticket.parent().and_then(Path::parent).map_or_else(
        String::new,
        |scratch| {
            format!(
                " Set TMPDIR, TMP and TEMP to `{}` for commands. Set CARGO_TARGET_DIR to `{}` for Cargo.",
                scratch.display(),
                paths.builds.display(),
            )
        },
    );
    if role == Role::Worker
        && let Some(report) = task.report_task()
    {
        use std::fmt::Write as _;

        let command = shell_path(paths.command);
        let ticket = shell_path(paths.ticket);
        let mut prompt = format!(
            "This brief opts into report-only delivery. Run the brief's selectors for commit {base} in the disposable task checkout. Confirm the checkout is on {branch}. Leave it clean. Do not commit, push or open a PR.{storage}\n\nRead the delivery lane with `{command} lane.get {project} {lane} --ticket {ticket}`. Export each settled slice immediately: feed the updated Markdown on stdin to `{command} lane.put {project} {lane} VERSION --ticket {ticket}`, using the version you last read. Preserve existing lane content and re-read if a concurrent edit advances the version. Keep all surviving evidence in the lane or in retained runner logs.\n\nWhen finished, send {{\"report_ready\":{{\"artifact\":{{\"key\":\"{lane}\",\"version\":VERSION,\"digest\":\"DIGEST\"}},\"headline\":\"HEADLINE\",\"summary\":\"SUMMARY\",\"head\":\"FULL_SHA\"}}}} on stdin to `{command} report --ticket {ticket}`. Use the latest exact artifact returned by the lane command and the actual checkout head. If unable to deliver, send {{\"blocked\":{{\"summary\":\"REASON\"}}}} or {{\"error\":{{\"summary\":\"REASON\"}}}} instead. Keep the ticket contents private. Once the report is accepted, finish the turn and wait for the planner.",
            base = report.planning_base,
            project = report.project,
            lane = report.lane,
        );
        if let Some(instruction) = &report.instruction {
            let _ = write!(
                prompt,
                "\n\nPlanner's revision instruction\n\n{instruction}"
            );
        }
        let _ = write!(prompt, "\n\nBrief\n\n{}", task.brief().text);
        return prompt;
    }
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
    let mut prompt = format!(
        "{assignment}\n\nUse this task's checkout and repository only.{storage} Send {report} on stdin to the local CLI at {} with arguments `report --ticket` and ticket path {}. If you need a planning decision, send {question}. Keep the ticket contents private.\n\nBrief\n\n{}",
        paths.command.display(),
        paths.ticket.display(),
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

fn shell_path(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}
