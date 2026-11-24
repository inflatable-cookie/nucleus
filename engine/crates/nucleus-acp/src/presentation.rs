use std::{
    collections::BTreeMap,
    fmt::Write as _,
    sync::LazyLock,
    time::{SystemTime, UNIX_EPOCH},
};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{Phase, Question, Repair, Review, Role, Verdict, acp::lifecycle::StepState};
use serde_json::{Value, json};

use crate::client::{Activity, Detail, Event, Milestone};

#[derive(Default)]
pub(crate) struct Presentation {
    pub cursor: i64,
    plan: Option<Value>,
    runs: BTreeMap<String, Tool>,
    order: Vec<String>,
    question: Option<Question>,
    phase: Option<Phase>,
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

        if structured {
            let plan = plan(&detail);
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
                updates.push(message(&question_text(question, detail.operator_inbox)));
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

fn plan(detail: &Detail) -> Value {
    let steps = &detail.lifecycle.steps;
    let entries: Vec<_> = steps
        .iter()
        .enumerate()
        .map(|(index, step)| {
            let mut content = step.label.clone();
            if step.state == StepState::Current
                || (detail.phase == Phase::Done && index + 1 == steps.len())
            {
                if let Some(reference) = &detail.reference {
                    content = format!("{reference} · {content}");
                }
                if detail.phase == Phase::ReportReady
                    && let Some(delivery) = detail
                        .report
                        .as_ref()
                        .and_then(|report| report.delivery.as_ref())
                {
                    let _ = write!(
                        content,
                        " · {} v{}",
                        delivery.artifact.key, delivery.artifact.version
                    );
                }
            }
            for suffix in [&step.round_label, &step.note].into_iter().flatten() {
                let _ = write!(content, " · {suffix}");
            }
            let status = match step.state {
                StepState::Done => "completed",
                StepState::Current if detail.phase == Phase::Cancelled => "completed",
                StepState::Current => "in_progress",
                StepState::Todo => "pending",
            };
            json!({"content":content,"priority":"medium","status":status})
        })
        .collect();
    json!({"sessionUpdate":"plan","entries":entries})
}

fn question_text(question: &Question, operator_inbox: bool) -> String {
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
        Question::Accept { head } if operator_inbox => format!(
            "The external merge at {head} needs operator acceptance. Answer in the pinned Nucleus Inbox."
        ),
        Question::Accept { .. } => {
            "An external merge needs acceptance. Use `answer accept <head> <reason>`.".into()
        }
        Question::Allowance { used_ms, limit_ms } => format!(
            "The planner can extend the task allowance. Used {} of {} minutes.",
            used_ms / 60_000,
            limit_ms / 60_000
        ),
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
