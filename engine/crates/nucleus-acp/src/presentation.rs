use std::{
    collections::BTreeMap,
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Phase, Question, Repair, Review, Role, Verdict};
use serde_json::{Value, json};

use crate::client::{Activity, Detail, Event, Milestone};

#[derive(Default)]
pub(crate) struct Presentation {
    pub cursor: i64,
    plan: Option<Value>,
    runs: BTreeMap<String, Tool>,
    order: Vec<String>,
    completed_reviews: usize,
    question: Option<Question>,
    phase: Option<Phase>,
    last_active_phase: Option<Phase>,
}

struct Tool {
    title: String,
    ended: bool,
    shown: Option<(bool, Option<Activity>)>,
}

impl Presentation {
    pub(crate) fn update(
        &mut self,
        detail: Detail,
        history: Vec<Event>,
        structured: bool,
    ) -> Vec<Value> {
        let mut updates = Vec::new();
        let attaching = self.phase.is_none();
        for event in history {
            self.cursor = self.cursor.max(event.sequence);
            for record in event.presentation {
                self.apply(record, attaching, &mut updates);
            }
        }

        if !detail.phase.is_terminal() {
            self.last_active_phase = Some(detail.phase);
        }
        if structured {
            let plan = plan(&detail, self.completed_reviews, self.last_active_phase);
            if self.plan.as_ref() != Some(&plan) {
                updates.push(plan.clone());
                self.plan = Some(plan);
            }
            let active = detail.run.as_ref().filter(|run| run.last_send_at.is_some());
            if let Some(run) = active {
                self.start(&run.instance, run.role, &run.purpose);
            }
            for instance in &self.order {
                let tool = self.runs.get_mut(instance).expect("ordered run");
                let activity = active
                    .filter(|run| &run.instance == instance)
                    .and_then(|run| run.activity.clone())
                    .filter(|_| !tool.ended);
                if let Some(update) = tool.update(instance, activity) {
                    updates.push(update);
                }
            }
        }
        if detail.question != self.question {
            if let Some(question) = &detail.question {
                updates.push(message(&question_text(question)));
            }
            self.question = detail.question;
        }
        if self.phase != Some(detail.phase) && detail.phase.is_terminal() {
            let summary = if detail.phase == Phase::Done {
                detail.pull_request.map_or_else(
                    || "Task complete.".into(),
                    |pr| format!("Task complete. [Pull request]({}).", pr.url),
                )
            } else {
                "Task cancelled.".into()
            };
            updates.push(message(&summary));
        }
        self.phase = Some(detail.phase);
        updates
    }

    fn apply(&mut self, record: Milestone, attaching: bool, updates: &mut Vec<Value>) {
        match record {
            Milestone::RunStarted {
                instance,
                role,
                purpose,
            } => self.start(&instance, role, &purpose),
            Milestone::RunEnded { instance } => {
                if let Some(run) = self.runs.get_mut(&instance) {
                    run.ended = true;
                }
            }
            Milestone::Verdict { verdict } => {
                if matches!(verdict, Verdict::Reviewed { .. }) {
                    self.completed_reviews += 1;
                }
                if !attaching {
                    let text = match verdict {
                        Verdict::Reviewed {
                            decision: Review::Approve,
                            summary,
                            ..
                        } => format!("Review approved. {summary}"),
                        Verdict::Reviewed { summary, .. } => {
                            format!("Review requested changes. {summary}")
                        }
                        Verdict::Accepted { acceptance, .. } => {
                            format!("External merge accepted. {}", acceptance.reason)
                        }
                    };
                    updates.push(message(text.trim_end()));
                }
            }
            Milestone::PullRequest { url } if !attaching => {
                updates.push(message(&format!("Opened [the pull request]({url}).")));
            }
            Milestone::Merged if !attaching => {
                updates.push(message("The pull request was merged."));
            }
            _ => {}
        }
    }

    fn start(&mut self, instance: &str, role: Role, purpose: &str) {
        if !self.runs.contains_key(instance) {
            let role = match role {
                Role::Worker => "Worker",
                Role::Reviewer => "Reviewer",
            };
            self.order.push(instance.into());
            self.runs.insert(
                instance.into(),
                Tool {
                    title: format!("{role}: {purpose}"),
                    ended: false,
                    shown: None,
                },
            );
        }
    }
}

impl Tool {
    fn update(&mut self, instance: &str, activity: Option<Activity>) -> Option<Value> {
        let next = (self.ended, activity);
        if self.shown.as_ref() == Some(&next) {
            return None;
        }
        let status = if self.ended {
            "completed"
        } else {
            "in_progress"
        };
        let content: Vec<_> = next
            .1
            .iter()
            .map(|activity| {
                let text = activity.started_at.map_or_else(
                    || activity.label.clone(),
                    |started| {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        let secs = now.saturating_sub(started.into()) / 1000;
                        let elapsed = if secs < 60 {
                            format!("{secs}s")
                        } else {
                            format!("{}m {}s", secs / 60, secs % 60)
                        };
                        format!("{} · {elapsed}", activity.label)
                    },
                );
                json!({"type":"content","content":{"type":"text","text":text}})
            })
            .collect();
        let update = if self.shown.is_some() {
            json!({"sessionUpdate":"tool_call_update","toolCallId":instance,"status":status,"content":content})
        } else {
            json!({"sessionUpdate":"tool_call","toolCallId":instance,"title":self.title,"kind":"other","status":status,"content":content})
        };
        self.shown = Some(next);
        Some(update)
    }
}

fn plan(detail: &Detail, reviews: usize, previous: Option<Phase>) -> Value {
    let phase = match detail.phase {
        Phase::Cancelled => previous
            .filter(|phase| !phase.is_terminal())
            .unwrap_or(Phase::Queued),
        phase => phase,
    };
    let step = match phase {
        Phase::Queued | Phase::Cancelled => 0,
        Phase::Working => 1,
        Phase::Reviewing => 2,
        Phase::Merging => 3,
        Phase::Closing | Phase::Done => 4,
    };
    let round = if step <= 2 {
        reviews + 1
    } else {
        reviews.max(1)
    };
    let mut titles = [
        "Queued".into(),
        "Working".into(),
        format!("Review round {round}"),
        "Merge".into(),
        "Close".into(),
    ];
    if detail.phase == Phase::Cancelled {
        titles[step].push_str(" · cancelled");
    } else if !detail.phase.is_terminal()
        && let Some(wait) = wait_text(detail)
    {
        titles[step].push_str(" · ");
        titles[step].push_str(wait);
    }
    let entries: Vec<_> = titles
        .into_iter()
        .enumerate()
        .map(|(index, content)| {
            let status = if index < step
                || phase == Phase::Done
                || (index == step && detail.phase == Phase::Cancelled)
            {
                "completed"
            } else if index == step {
                "in_progress"
            } else {
                "pending"
            };
            json!({"content":content,"priority":"medium","status":status})
        })
        .collect();
    json!({"sessionUpdate":"plan","entries":entries})
}

fn wait_text(detail: &Detail) -> Option<&'static str> {
    Some(match detail.wait.as_deref()? {
        "capacity" if detail.phase == Phase::Reviewing => "waiting for a review slot",
        "capacity" => "waiting for a work slot",
        "checks_pending" => "waiting for checks",
        "hold" => "on hold",
        "input" | "question" => "waiting for an answer",
        "permission" => "waiting for permission",
        "forge_unknown" => "waiting for GitHub",
        "host_unknown" | "idle_without_terminal_run"
            if let Some(run) = &detail.run
                && run.reported =>
        {
            match run.role {
                Role::Worker => "waiting to confirm the worker is idle",
                Role::Reviewer => "waiting to confirm the reviewer is idle",
            }
        }
        "host_unknown" | "idle_without_terminal_run" => "waiting for the host",
        "operator_declined" => "operator declined. Move or cancel the task",
        "stopping" => "waiting for the run to finish",
        "workspace_unknown" => "checking the workspace",
        "retained_thread_busy" => "waiting for the previous turn",
        _ => return None,
    })
}

fn question_text(question: &Question) -> String {
    static REDACTOR: LazyLock<Redactor> =
        LazyLock::new(|| Redactor::new([], RedactionRules::common()));
    match question {
        Question::Work { prompt, .. } => {
            let excerpt: String = REDACTOR.redact(prompt).text.chars().take(320).collect();
            format!("{excerpt}\n\nAnswer with `answer work <guidance>`.")
        }
        Question::Retry { role } => {
            let role = if *role == Role::Worker {
                "worker"
            } else {
                "reviewer"
            };
            format!("The {role} could not finish. Use `answer retry` to try again.")
        }
        Question::Accept { .. } => {
            "An external merge needs acceptance. Use `answer accept <head> <reason>`.".into()
        }
        Question::Repair(reason) => {
            let problem = match reason {
                Repair::PullRequestUnavailable => "The pull request could not be confirmed.",
                Repair::WorkspaceHeadMismatch => {
                    "The workspace differs from the pull request head."
                }
                Repair::RevisionHasSameHead => {
                    "The revision still has the previously reviewed head."
                }
                Repair::MergeBlocked => "GitHub is blocking the merge.",
                Repair::MergeUnconfirmed => "GitHub has not confirmed the merge.",
            };
            format!("{problem} Answer with `answer work <guidance>`.")
        }
    }
}

pub(crate) fn message(text: &str) -> Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("{text}\n\n")}})
}
