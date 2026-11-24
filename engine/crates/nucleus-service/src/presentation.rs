//! Display projections from committed tasks and exact, in-memory run evidence.

use std::sync::LazyLock;

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Forge, Head, Observed, Phase, Question, Role, Task, Verdict, WaitReason};
use nucleus_hosts::RunActivity;
use nucleus_store::{DependencyBoardLabels, Event, EventDraft, Store, TaskRow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{ServiceError, State, dependencies::checks_prerequisites, titles};

#[derive(PartialEq, Eq)]
pub(super) struct ActivityAt {
    pub(super) version: i64,
    pub(super) instance: String,
    pub(super) activity: RunActivity,
}

impl ActivityAt {
    fn current(&self, row: &TaskRow) -> Option<&RunActivity> {
        let run = row.task.run()?;
        (!run.revoked() && self.version == row.version && self.instance == run.launch().instance)
            .then_some(&self.activity)
    }
}

pub(super) fn board_state(
    task: &Task,
    state: &State,
) -> Result<(String, Option<u64>, Option<u64>), ServiceError> {
    let record = state.store.board_state(&task.identity().id)?;
    let label = record
        .label
        .unwrap_or_else(|| legacy_label(task, record.legacy_host_blocked));
    Ok((label, record.since_ms, record.created_at_ms))
}

fn legacy_label(task: &Task, legacy_host_blocked: bool) -> String {
    titles::task_state_label(
        task,
        legacy_host_blocked.then_some(WaitReason::HostObservationBlocked),
    )
}

pub(super) fn record_wait_state(
    state: &State,
    task: &Task,
    wait: Option<WaitReason>,
) -> Result<bool, ServiceError> {
    let id = &task.identity().id;
    let label = titles::task_state_label(task, wait);
    let previous = state.store.board_state(id)?;
    if previous.label.as_deref() == Some(&label) {
        return Ok(false);
    }
    let changed = previous.label.as_ref().map_or_else(
        || label != legacy_label(task, previous.legacy_host_blocked),
        |old| label != *old,
    );
    let since = if changed && (previous.label.is_some() || previous.legacy_host_blocked) {
        Some(crate::now_ms())
    } else {
        // The first pass after upgrade may observe a wait already in progress.
        previous.since_ms.filter(|_| !changed)
    };
    state.store.record_board_state(
        id,
        &label,
        since.and_then(|value| i64::try_from(value).ok()),
    )?;
    Ok(changed)
}

pub(super) fn prerequisite_labels(task: &Task) -> Option<DependencyBoardLabels> {
    checks_prerequisites(task).then(|| DependencyBoardLabels {
        ready: titles::task_state_label(task, None),
        blocked: titles::task_state_label(task, Some(WaitReason::Prerequisite)),
    })
}

pub(super) fn committed_board_state(
    state: &State,
    prior: &Task,
    task: &Task,
) -> Result<Option<String>, ServiceError> {
    fn run_basis(task: &Task) -> Option<(&str, bool, bool)> {
        task.run().map(|run| {
            (
                run.launch().instance.as_str(),
                run.revoked(),
                run.report().is_some(),
            )
        })
    }
    // A new role or phase invalidates waits observed for the previous work.
    let label = titles::task_state_label(task, None);
    if label == titles::task_state_label(prior, None)
        && task.phase() == prior.phase()
        && run_basis(task) == run_basis(prior)
    {
        return Ok(None);
    }
    let label =
        if checks_prerequisites(task) && state.store.dependency_blocked(&task.identity().id)? {
            titles::task_state_label(task, Some(WaitReason::Prerequisite))
        } else {
            label
        };
    Ok(Some(label))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunView {
    role: Role,
    thread: String,
    instance: String,
    purpose: String,
    reserved_at: u64,
    last_send_at: Option<u64>,
    review_head: Option<Head>,
    reported: bool,
    revoked: bool,
    activity: Option<RunActivity>,
}

impl RunView {
    pub(super) fn read(
        row: &TaskRow,
        activity: Option<&ActivityAt>,
        store: &Store,
    ) -> Option<Self> {
        let run = row.task.run()?;
        let launch = run.launch();
        Some(Self {
            role: launch.role,
            thread: launch.thread.clone(),
            instance: launch.instance.clone(),
            purpose: purpose(&row.task, launch.role, store),
            reserved_at: launch.started_at,
            last_send_at: run.last_send_at_ms(),
            review_head: launch.review_head.clone(),
            reported: run.report().is_some(),
            revoked: run.revoked(),
            activity: activity.and_then(|seen| seen.current(row)).cloned(),
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Milestone {
    RunStarted {
        instance: String,
        role: Role,
        purpose: String,
        review_head: Option<Head>,
    },
    RunEnded {
        instance: String,
    },
    PullRequest {
        url: String,
    },
    Verdict {
        verdict: Verdict,
    },
    Question {
        question: Question,
    },
    Merged {
        commit: Head,
    },
    Finished {
        phase: Phase,
    },
}

#[derive(Serialize)]
pub(super) struct HistoryEvent {
    #[serde(flatten)]
    event: Event,
    presentation: Vec<Milestone>,
}

impl From<Event> for HistoryEvent {
    fn from(mut event: Event) -> Self {
        let presentation = serde_json::from_str::<Map<String, Value>>(&event.content.detail)
            .ok()
            .and_then(|mut detail| {
                let records = serde_json::from_value(detail.remove("presentation")?).ok()?;
                event.content.detail = if detail.is_empty() {
                    String::new()
                } else {
                    Value::Object(detail).to_string()
                };
                Some(records)
            })
            .unwrap_or_default();
        Self {
            event,
            presentation,
        }
    }
}

// Only an observed merge can announce a merge. Keep the proof separately
// from the phase so an explicit move can't invent a confirmation.
pub(super) fn note_merge(audit: &mut EventDraft, forge: &Observed<Forge>) {
    if let Observed::Known(Forge::Merged { commit, .. }) = forge {
        audit.detail = json!({ "mergeCommit": commit }).to_string();
    }
}

pub(super) fn decorate(prior: &Task, task: &Task, audit: &EventDraft, store: &Store) -> EventDraft {
    let mut records = Vec::new();
    let prior_run = prior.run().filter(|run| run.last_send_at_ms().is_some());
    let run = task.run().filter(|run| run.last_send_at_ms().is_some());
    if prior_run.map(|run| &run.launch().instance) != run.map(|run| &run.launch().instance) {
        if let Some(run) = prior_run {
            records.push(Milestone::RunEnded {
                instance: run.launch().instance.clone(),
            });
        }
        if let Some(run) = run {
            let launch = run.launch();
            records.push(Milestone::RunStarted {
                instance: launch.instance.clone(),
                role: launch.role,
                purpose: purpose(task, launch.role, store),
                review_head: launch.review_head.clone(),
            });
        }
    }
    if let Some(pr) = task.pull_request()
        && prior.pull_request().is_none_or(|old| old.url != pr.url)
    {
        records.push(Milestone::PullRequest {
            url: pr.url.clone(),
        });
    }
    if let Some(verdict) = task
        .verdict()
        .filter(|verdict| prior.verdict() != Some(verdict))
    {
        let mut verdict = verdict.clone();
        let summary = match &mut verdict {
            Verdict::Reviewed { summary, .. } => summary,
            Verdict::Accepted { acceptance, .. } => &mut acceptance.reason,
        };
        *summary = excerpt(summary, 320);
        records.push(Milestone::Verdict { verdict });
    }
    if let Some(question) = task
        .question()
        .filter(|question| prior.question() != Some(question))
    {
        let mut question = question.clone();
        if let Question::Work { prompt, options } = &mut question {
            *prompt = excerpt(prompt, 320);
            for option in options {
                *option = excerpt(option, 160);
            }
        }
        records.push(Milestone::Question { question });
    }

    let mut audit = audit.clone();
    let mut detail = serde_json::from_str::<Map<String, Value>>(&audit.detail).unwrap_or_default();
    if !matches!(prior.phase(), Phase::Closing | Phase::Done)
        && matches!(task.phase(), Phase::Closing | Phase::Done)
        && let Some(commit) = detail.get("mergeCommit")
        && let Ok(commit) = serde_json::from_value(commit.clone())
    {
        records.push(Milestone::Merged { commit });
    }
    if prior.phase() != task.phase() && task.phase().is_terminal() {
        records.push(Milestone::Finished {
            phase: task.phase(),
        });
    }
    if !records.is_empty() {
        detail.insert("presentation".into(), json!(records));
    }
    if detail.contains_key("presentation") {
        audit.detail = Value::Object(detail).to_string();
    }
    audit
}

fn purpose(task: &Task, role: Role, store: &Store) -> String {
    match role {
        Role::Worker => brief_title(&task.brief().text)
            .map_or_else(|| "Implement the brief".into(), |line| excerpt(line, 100)),
        Role::Reviewer => store.completed_reviews(&task.identity().id).map_or_else(
            |_| "Review the exact PR head".into(),
            |completed| format!("Checking round {}", completed.saturating_add(1)),
        ),
    }
}

pub(super) fn brief_title(text: &str) -> Option<&str> {
    let mut lines = text
        .lines()
        .skip_while(|line| line.trim().is_empty())
        .peekable();
    if lines.peek()?.trim_end() == "---" {
        lines.next();
        lines.find(|line| line.trim_end() == "---")?;
    }
    let mut prose = None;
    let mut fence = None;
    for line in lines {
        let trimmed = line.trim_start_matches(' ');
        if line.len() - trimmed.len() > 3 || trimmed.starts_with('\t') {
            continue;
        }
        let line = trimmed.trim_end();
        if line.is_empty() {
            continue;
        }
        let marker = line.as_bytes()[0];
        let width = line.bytes().take_while(|&byte| byte == marker).count();
        if let Some((open, minimum)) = fence {
            if marker == open && width >= minimum && width == line.len() {
                fence = None;
            }
            continue;
        }
        if matches!(marker, b'`' | b'~') && width >= 3 {
            fence = Some((marker, width));
            continue;
        }
        if marker == b'#'
            && width <= 6
            && (line.len() == width || line[width..].starts_with([' ', '\t']))
        {
            let body = &line[width..];
            let without_closing = body.trim_end_matches('#');
            let heading = if without_closing.ends_with([' ', '\t']) {
                without_closing.trim()
            } else {
                body.trim()
            };
            if !heading.is_empty() {
                return Some(heading);
            }
            continue;
        }
        prose.get_or_insert(line);
    }
    prose
}

#[cfg(test)]
#[test]
fn brief_title_prefers_a_heading_to_prose_and_code() {
    let text = "---\nkind: work\n---\n\nAn introduction.\n\n```sh\n# An example\n```\n\n## Fix the retry test ##";
    assert_eq!(brief_title(text), Some("Fix the retry test"));
    assert_eq!(
        brief_title("Écrire le test.\n\n#not-a-heading"),
        Some("Écrire le test.")
    );
    assert_eq!(brief_title("---\nkind: work"), None);
}

pub(super) fn excerpt(value: &str, limit: usize) -> String {
    static REDACTOR: LazyLock<Redactor> =
        LazyLock::new(|| Redactor::new([], RedactionRules::common()));
    REDACTOR.redact(value).text.chars().take(limit).collect()
}
