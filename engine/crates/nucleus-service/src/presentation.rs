//! Display projections from committed tasks and exact, in-memory run evidence.

mod lifecycle;

use std::sync::LazyLock;

pub(super) use lifecycle::read as task_lifecycle;

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{
    Forge, Head, Observed, Phase, Question, Report, Review, Role, Task, Verdict, WaitReason,
    acp::lifecycle::{Milestone, Outcome},
};
use nucleus_hosts::RunActivity;
use nucleus_store::{DependencyClock, Event, EventDraft, Store, StoreError, TaskRow};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::{State, dependencies::checks_prerequisites, titles};

#[derive(PartialEq, Eq)]
pub(super) struct ActivityAt {
    pub(super) version: i64,
    pub(super) instance: String,
    pub(super) activity: RunActivity,
}

impl State {
    pub(super) fn effective_wait(&self, task: &Task) -> Result<Option<WaitReason>, StoreError> {
        match self.waits.get(&task.identity().id) {
            Some(wait) => Ok(wait.reason),
            None => self.prerequisite_wait(task),
        }
    }

    fn prerequisite_wait(&self, task: &Task) -> Result<Option<WaitReason>, StoreError> {
        Ok(
            (checks_prerequisites(task) && self.store.dependency_blocked(&task.identity().id)?)
                .then_some(WaitReason::Prerequisite),
        )
    }

    pub(super) fn task_wait_transition(
        &self,
        prior: &Task,
        task: &Task,
    ) -> Result<(Option<WaitReason>, bool), StoreError> {
        let before = self.effective_wait(prior)?;
        let initial_send = prior
            .run()
            .is_some_and(|run| run.last_send_at_ms().is_none())
            && task
                .run()
                .is_some_and(|run| !run.revoked() && run.last_send_at_ms().is_some());
        let after = if initial_send {
            Some(WaitReason::Starting)
        } else if prior.phase() == task.phase()
            && run_basis(prior) == run_basis(task)
            && prior.hold() == task.hold()
            && prior.question() == task.question()
            && prior.operator_decline() == task.operator_decline()
            && prior.pull_request() == task.pull_request()
            && prior.verdict() == task.verdict()
        {
            before
        } else {
            self.prerequisite_wait(task)?
        };
        Ok((
            after,
            titles::task_state_label(prior, before, self.wait_detail(&prior.identity().id))
                != titles::task_state_label(task, after, self.wait_detail(&task.identity().id)),
        ))
    }

    pub(super) fn edit_board_dependency<T>(
        &mut self,
        task: &Task,
        edit: impl FnOnce(&mut Store, DependencyClock<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let before = self.effective_wait(task)?;
        let detail = self
            .waits
            .get(&task.identity().id)
            .and_then(|wait| wait.detail.as_ref());
        let mut after = before;
        let mut changed = false;
        let result = edit(&mut self.store, &mut |blocked| {
            after = if blocked && checks_prerequisites(task) {
                Some(WaitReason::Prerequisite)
            } else {
                before.filter(|reason| *reason != WaitReason::Prerequisite)
            };
            changed = titles::task_state_label(task, before, detail)
                != titles::task_state_label(task, after, detail);
            changed
        })?;
        self.apply_task_wait(task, after, changed);
        Ok(result)
    }
}

fn run_basis(task: &Task) -> Option<(&str, bool, bool, Option<&Report>)> {
    task.run().map(|run| {
        (
            run.launch().instance.as_str(),
            run.last_send_at_ms().is_some(),
            run.revoked(),
            run.report(),
        )
    })
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
        review_round: Option<u64>,
    ) -> Option<Self> {
        let run = row.task.run()?;
        let launch = run.launch();
        Some(Self {
            role: launch.role,
            thread: launch.thread.clone(),
            instance: launch.instance.clone(),
            purpose: purpose(&row.task, launch.role, review_round),
            reserved_at: launch.started_at,
            last_send_at: run.last_send_at_ms(),
            review_head: launch.review_head.clone(),
            reported: run.report().is_some(),
            revoked: run.revoked(),
            activity: run_activity(row, activity).cloned(),
        })
    }
}

pub(super) fn run_activity<'a>(
    row: &TaskRow,
    activity: Option<&'a ActivityAt>,
) -> Option<&'a RunActivity> {
    let run = row.task.run().filter(|run| !run.revoked())?;
    activity
        .filter(|seen| seen.version == row.version && seen.instance == run.launch().instance)
        .map(|seen| &seen.activity)
}

#[derive(Clone, Copy)]
pub(super) struct TranscriptRequest<'a> {
    pub(super) activity: Option<&'a str>,
}

pub(super) fn retained_launch(
    store: &Store,
    task: &str,
    threads: &[&str],
) -> Result<Option<(String, String)>, nucleus_store::StoreError> {
    Ok(store
        .lifecycle_events(task)?
        .into_iter()
        .rev()
        .flat_map(|event| HistoryEvent::from(event).presentation)
        .find_map(|event| match event {
            Milestone::RunStarted {
                instance,
                thread: Some(thread),
                ..
            } if threads.contains(&thread.as_str()) => Some((thread, instance)),
            _ => None,
        }))
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
            let round = (launch.role == Role::Reviewer)
                .then(|| lifecycle::Audit::read(store, task).ok())
                .flatten()
                .map(|audit| audit.next_review_round());
            records.push(Milestone::RunStarted {
                instance: launch.instance.clone(),
                role: launch.role,
                purpose: purpose(task, launch.role, round),
                review_head: launch.review_head.clone(),
                thread: Some(launch.thread.clone()),
                provider: launch.profile().map(|profile| profile.provider),
                model: launch.profile().map(|profile| profile.model.clone()),
                model_observed: false,
                started_at_ms: run.last_send_at_ms(),
                round,
            });
        }
    }
    if let Some(run) = run
        && let Some(report) = run.report()
        && prior_run.is_some_and(|prior| prior.report().is_none())
        && let Some(sent_at_ms) = run.last_send_at_ms()
    {
        records.push(Milestone::RunReported {
            instance: run.launch().instance.clone(),
            sent_at_ms,
            outcome: Some(report_outcome(task, report)),
        });
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
        redact_question(&mut question);
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
            previous_phase: Some(prior.phase()),
        });
    }
    if !records.is_empty() {
        detail.insert("presentation".into(), json!(records));
        audit.detail = Value::Object(detail).to_string();
    }
    audit
}

fn report_outcome(task: &Task, report: &Report) -> Outcome {
    match report {
        Report::Work(report) => Outcome::Work {
            url: report.pull_request.url.clone(),
            summary: report.summary.as_deref().and_then(summary_line),
            revision: is_revision(task),
        },
        Report::Review {
            head,
            decision,
            summary,
            finding_titles,
        } => Outcome::Review {
            decision: *decision,
            summary: one_line(summary, 240),
            finding_titles: finding_titles
                .iter()
                .map(|title| one_line(title, 120))
                .filter(|title| !title.is_empty())
                .take(20)
                .collect(),
            change_url: task
                .pull_request()
                .filter(|pr| pr.head == *head)
                .map(|pr| format!("{}/commits/{head}", pr.url.trim_end_matches('/'))),
        },
        Report::ReportReady(delivery) => Outcome::Report {
            summary: summary_line(&delivery.summary)
                .or_else(|| delivery.headline.as_deref().and_then(summary_line))
                .unwrap_or_default(),
        },
        Report::Blocked(failure) | Report::Error(failure) => Outcome::Blocked {
            reason: summary_line(&failure.summary)
                .or_else(|| failure.headline.as_deref().and_then(summary_line))
                .unwrap_or_else(|| "The worker did not supply a reason.".into()),
        },
        Report::Question { prompt, options } => {
            let mut question = Question::Work {
                prompt: prompt.clone(),
                options: options.clone(),
            };
            redact_question(&mut question);
            Outcome::Question { question }
        }
    }
}

fn redact_question(question: &mut Question) {
    if let Question::Work { prompt, options } = question {
        *prompt = excerpt(prompt, 320);
        for option in options {
            *option = excerpt(option, 160);
        }
    }
}

pub(super) fn is_revision(task: &Task) -> bool {
    matches!(
        task.verdict(),
        Some(Verdict::Reviewed {
            decision: Review::Changes,
            ..
        })
    )
}

fn summary_line(text: &str) -> Option<String> {
    let line = one_line(text, 240);
    (!line.is_empty()).then_some(line)
}

fn one_line(text: &str, limit: usize) -> String {
    excerpt(text, limit)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn role_start_line(task: &Task, store: &Store) -> String {
    match task.phase() {
        Phase::Reviewing => lifecycle::Audit::read(store, task).map_or_else(
            |_| "Starting review".into(),
            |audit| format!("Starting reviewer round {}", audit.next_review_round()),
        ),
        Phase::Working if is_revision(task) => "Starting revisions".into(),
        _ => "Starting work".into(),
    }
}

fn purpose(task: &Task, role: Role, review_round: Option<u64>) -> String {
    match role {
        Role::Worker => brief_title(&task.brief().text)
            .map_or_else(|| "Implement the brief".into(), |line| excerpt(line, 100)),
        Role::Reviewer => review_round.map_or_else(
            || "Review the exact PR head".into(),
            |round| format!("Checking round {round}"),
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
