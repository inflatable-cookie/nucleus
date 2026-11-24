//! Display projections from committed tasks and exact, in-memory run evidence.

use std::sync::LazyLock;

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Forge, Head, Observed, Phase, Question, Role, Task, Verdict, WaitReason};
use nucleus_hosts::RunActivity;
use nucleus_store::{DependencyClock, Event, EventDraft, Store, StoreError, TaskRow};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::{ServiceError, State, dependencies::checks_prerequisites, titles};

#[derive(PartialEq, Eq)]
pub(super) struct ActivityAt {
    pub(super) version: i64,
    pub(super) instance: String,
    pub(super) activity: RunActivity,
}

#[derive(Clone, Copy)]
pub(super) struct BoardWait {
    pub(super) reason: Option<WaitReason>,
    timed: bool,
}

impl BoardWait {
    fn transition(self, prior: &Task, task: &Task, reason: Option<WaitReason>) -> (Self, bool) {
        let changed =
            titles::task_state_label(prior, self.reason) != titles::task_state_label(task, reason);
        (
            Self {
                reason,
                timed: self.timed || changed,
            },
            changed,
        )
    }
}

impl State {
    pub(super) fn board_wait(&self, task: &Task) -> Result<BoardWait, StoreError> {
        let id = &task.identity().id;
        if let Some(wait) = self.board_waits.get(id) {
            return Ok(*wait);
        }
        Ok(BoardWait {
            reason: self.prerequisite_wait(task)?,
            timed: false,
        })
    }

    fn prerequisite_wait(&self, task: &Task) -> Result<Option<WaitReason>, StoreError> {
        Ok(
            (checks_prerequisites(task) && self.store.dependency_blocked(&task.identity().id)?)
                .then_some(WaitReason::Prerequisite),
        )
    }

    pub(super) fn admit_board_wait(&mut self, task: &Task, reason: Option<WaitReason>) {
        self.board_waits.insert(
            task.identity().id.clone(),
            BoardWait {
                reason,
                timed: true,
            },
        );
    }

    pub(super) fn observe_board_wait(
        &mut self,
        task: &Task,
        reason: Option<WaitReason>,
    ) -> Result<bool, ServiceError> {
        let id = &task.identity().id;
        let before = self.board_wait(task)?;
        let (mut after, changed) = before.transition(task, task, reason);
        // A first observation supplies a comparison for later passes, not an entry time.
        if !self.board_waits.contains_key(id) {
            after.timed = false;
        } else if changed {
            self.store
                .record_board_entry(id, i64::try_from(crate::now_ms()).unwrap_or(i64::MAX))?;
        }
        self.remember_board_wait(task, after, true);
        Ok(changed)
    }

    pub(super) fn task_board_transition(
        &self,
        prior: &Task,
        task: &Task,
    ) -> Result<(BoardWait, bool), StoreError> {
        let before = self.board_wait(prior)?;
        let reason = if prior.phase() == task.phase()
            && run_basis(prior) == run_basis(task)
            && titles::task_state_label(prior, None) == titles::task_state_label(task, None)
        {
            before.reason
        } else {
            self.prerequisite_wait(task)?
        };
        Ok(before.transition(prior, task, reason))
    }

    pub(super) fn remember_board_wait(&mut self, task: &Task, wait: BoardWait, observed: bool) {
        let id = &task.identity().id;
        if task.phase().is_terminal() {
            self.board_waits.remove(id);
        } else if observed || self.board_waits.contains_key(id) {
            self.board_waits.insert(id.clone(), wait);
        }
    }

    pub(super) fn edit_board_dependency<T>(
        &mut self,
        task: &Task,
        edit: impl FnOnce(&mut Store, DependencyClock<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let before = self.board_wait(task)?;
        let mut after = before;
        let mut changed = false;
        let result = edit(&mut self.store, &mut |blocked| {
            let reason = if blocked && checks_prerequisites(task) {
                Some(WaitReason::Prerequisite)
            } else {
                before
                    .reason
                    .filter(|reason| *reason != WaitReason::Prerequisite)
            };
            (after, changed) = before.transition(task, task, reason);
            changed
        })?;
        self.remember_board_wait(task, after, changed);
        Ok(result)
    }

    pub(super) fn board_state(
        &self,
        task: &Task,
    ) -> Result<(String, Option<u64>, Option<u64>), ServiceError> {
        let wait = self.board_wait(task)?;
        let (since, created) = self.store.board_times(&task.identity().id)?;
        let since = since.filter(|_| wait.timed || task.phase().is_terminal());
        Ok((titles::task_state_label(task, wait.reason), since, created))
    }
}

fn run_basis(task: &Task) -> Option<(&str, bool, bool)> {
    task.run().map(|run| {
        (
            run.launch().instance.as_str(),
            run.revoked(),
            run.report().is_some(),
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
            activity: activity
                .filter(|seen| {
                    !run.revoked()
                        && seen.version == row.version
                        && seen.instance == launch.instance
                })
                .map(|seen| seen.activity.clone()),
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
