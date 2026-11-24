//! Display projections from committed tasks and exact, in-memory run evidence.

use std::sync::LazyLock;

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Forge, Head, Observed, Phase, Question, Role, Run, Task, Verdict, WaitReason};
use nucleus_hosts::RunActivity;
use nucleus_store::{Event, EventDraft, Store, TaskRow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{ServiceError, State, now_ms};

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

pub(super) fn state_times(
    row: &TaskRow,
    state: &State,
    wait: Option<WaitReason>,
) -> Result<(Option<u64>, Option<u64>), ServiceError> {
    let id = &row.task.identity().id;
    let audit = state.store.task_times(
        id,
        row.task.hold().is_some(),
        row.task.run().is_some_and(Run::revoked),
    )?;
    let activity = state.activity.get(id).and_then(|seen| seen.current(row));
    let waiting = state
        .waits
        .get(id)
        .filter(|(reason, _)| {
            Some(*reason) == wait && !matches!(reason, WaitReason::Running | WaitReason::Hold)
        })
        .map(|(_, since)| {
            now_ms().saturating_sub(u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX))
        });
    // TaskCard's since chain prefers the active turn, then stop, wait and hold.
    let since = activity
        .and_then(|activity| activity.started_at)
        .or(audit.stopping)
        .or(waiting)
        .or(audit.held)
        .or(audit.updated);
    Ok((since, audit.created))
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
    let started_hold = task.hold().is_some() && task.hold() != prior.hold();
    let started_stop =
        task.run().is_some_and(Run::revoked) && !prior.run().is_some_and(Run::revoked);
    if started_hold {
        detail.insert("holdStarted".into(), json!(true));
    }
    if started_stop {
        detail.insert("stopStarted".into(), json!(true));
    }
    if !records.is_empty() {
        detail.insert("presentation".into(), json!(records));
    }
    if started_hold || started_stop || detail.contains_key("presentation") {
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
