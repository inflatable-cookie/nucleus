use std::{collections::BTreeMap, fmt::Write as _, sync::LazyLock};

use longhorn_redact::{RedactionRules, Redactor};
use nucleus_core::{
    Phase, PullRequest, Question, Repair, Review, Role, Verdict,
    acp::lifecycle::{Milestone, Outcome, RunClock, StepState},
    profiles::Provider,
};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::client::{Activity, Detail, Event};

#[derive(Default)]
pub(crate) struct Presentation {
    pub cursor: i64,
    pub prompt_seen: bool,
    plan: Option<Value>,
    runs: BTreeMap<String, Tool>,
    order: Vec<String>,
    question: Option<Question>,
    pull_request_url: Option<String>,
    finished: bool,
    merged: bool,
}

struct Tool {
    role: Role,
    purpose: String,
    clock: RunClock,
    provider: Option<Provider>,
    model: Option<String>,
    thread_url: Option<String>,
    ended: bool,
    outcome: Option<Outcome>,
    shown: Option<Card>,
}

#[derive(PartialEq, Eq)]
struct Card {
    title: String,
    status: &'static str,
    lines: Vec<String>,
}

impl Presentation {
    pub(crate) fn update(
        &mut self,
        detail: &Detail,
        history: Vec<Event>,
        structured: bool,
        replay_cards: bool,
    ) -> Vec<Value> {
        let mut updates = Vec::new();
        let replay_cards = replay_cards && detail.plan_scope_id.is_some();
        let attaching = self.cursor == 0 && !self.prompt_seen;
        for event in history {
            if event.sequence > self.cursor {
                self.cursor = event.sequence;
                self.apply(event, detail.pull_request.as_ref(), attaching, &mut updates);
            }
        }

        if structured {
            let plan = plan(detail);
            if replay_cards || self.plan.as_ref() != Some(&plan) {
                updates.insert(0, plan.clone());
                self.plan = Some(plan);
            }
        }

        let active = detail.run.as_ref().filter(|run| run.last_send_at.is_some());
        if let Some(run) = active {
            let tool = self.start(&run.instance, run.role, &run.purpose);
            tool.fill_participant(
                run.provider,
                run.model.as_deref(),
                run.thread_url.as_deref(),
            );
            if let Some(sent) = run.last_send_at {
                tool.clock.sent(sent);
            }
            if tool.outcome.is_none() {
                tool.outcome.clone_from(&run.outcome);
            }
        }

        for participant in [&detail.lifecycle.worker, &detail.lifecycle.reviewer]
            .into_iter()
            .flatten()
        {
            if let Some(tool) = participant
                .origin_instance
                .as_ref()
                .and_then(|instance| self.runs.get_mut(instance))
            {
                // A retained binding may fill in the exact, original launch on old rows.
                tool.fill_participant(
                    participant.provider,
                    participant.model.as_deref(),
                    participant.thread_url.as_deref(),
                );
            }
        }

        // Only the most recent occurrence of the open question can still be answered.
        let question_owner = detail.question.as_ref().and_then(|question| {
            self.order.iter().rev().find(|&instance| {
                matches!(&self.runs[instance].outcome, Some(Outcome::Question { question: asked })
                    if question_summary(asked) == question_summary(question))
            })
        });
        for instance in &self.order {
            let tool = self.runs.get_mut(instance).expect("ordered run");
            let activity = active
                .filter(|run| run.instance == *instance)
                .and_then(|run| run.activity.as_ref());
            let answer = (question_owner == Some(instance)).then(|| answer_action(detail));
            if let Some(update) = tool.render(
                instance,
                activity,
                answer.as_deref(),
                structured,
                replay_cards,
            ) {
                updates.push(update);
            }
        }
        if detail.question != self.question {
            if question_owner.is_none()
                && let Some(question) = &detail.question
            {
                updates.push(message(&format!(
                    "{}\n\n{}",
                    question_summary(question),
                    answer_action(detail)
                )));
            }
            self.question.clone_from(&detail.question);
        }
        if detail.phase.is_terminal() && !self.finished {
            updates.push(message(&finish(detail, self.merged)));
            self.finished = true;
        }
        updates
    }

    fn apply(
        &mut self,
        event: Event,
        current_pr: Option<&PullRequest>,
        attaching: bool,
        updates: &mut Vec<Value>,
    ) {
        let at = event.content.as_ref().map(|content| content.at);
        self.apply_legacy_clock(&event);
        let mut ended = None;
        for record in event.presentation {
            match record {
                Milestone::RunStarted {
                    instance,
                    role,
                    purpose,
                    provider,
                    model,
                    thread_url,
                    started_at_ms,
                    ..
                } => {
                    let tool = self.start(&instance, role, &purpose);
                    tool.fill_participant(provider, model.as_deref(), thread_url.as_deref());
                    if let Some(at) = started_at_ms.or(at) {
                        tool.clock.sent(at);
                    }
                }
                Milestone::RunReported {
                    instance,
                    sent_at_ms,
                    outcome,
                } => {
                    if let Some(tool) = self.runs.get_mut(&instance) {
                        tool.record_report(at, sent_at_ms, outcome);
                    }
                }
                Milestone::RunEnded { instance, outcome } => {
                    if let Some(tool) = self.runs.get_mut(&instance) {
                        tool.ended = true;
                        if tool.outcome.is_none() {
                            tool.outcome = outcome;
                        }
                        ended = Some(instance);
                    }
                }
                Milestone::PullRequest { url } => {
                    if let Some(tool) = ended.as_ref().and_then(|id| self.runs.get_mut(id))
                        && tool.role == Role::Worker
                    {
                        tool.outcome.get_or_insert(Outcome::Work {
                            url: url.clone(),
                            summary: None,
                            revision: false,
                        });
                    }
                    self.pull_request_url = Some(url);
                }
                Milestone::Verdict {
                    verdict:
                        Verdict::Reviewed {
                            head,
                            decision,
                            summary,
                        },
                } => {
                    if let Some(tool) = ended.as_ref().and_then(|id| self.runs.get_mut(id))
                        && tool.role == Role::Reviewer
                    {
                        tool.outcome.get_or_insert(Outcome::Review {
                            decision,
                            summary,
                            finding_titles: Vec::new(),
                            change_url: self
                                .pull_request_url
                                .as_deref()
                                .or_else(|| {
                                    current_pr
                                        .filter(|pr| pr.head == head)
                                        .map(|pr| pr.url.as_str())
                                })
                                .map(|url| format!("{}/commits/{head}", url.trim_end_matches('/'))),
                        });
                    }
                }
                Milestone::Verdict {
                    verdict: Verdict::Accepted { acceptance, .. },
                } => {
                    if !attaching {
                        updates.push(message(&format!(
                            "External merge accepted. {}",
                            acceptance.reason
                        )));
                    }
                }
                Milestone::Question { question } => {
                    if let Some(tool) = ended.as_ref().and_then(|id| self.runs.get_mut(id)) {
                        tool.outcome.get_or_insert(Outcome::Question { question });
                    }
                }
                Milestone::Merged { .. } => self.merged = true,
                Milestone::Finished { .. } => {}
            }
        }
    }

    fn apply_legacy_clock(&mut self, event: &Event) {
        if let Some(instance) = self.order.last()
            && let Some(tool) = self.runs.get_mut(instance)
            && !tool.ended
            && let Some(content) = &event.content
            && event.presentation.is_empty()
        {
            match content.kind.as_str() {
                "host_send" => tool.clock.sent(content.at),
                "reported" => tool.clock.reported(content.at, None),
                _ => {}
            }
        }
    }

    fn start(&mut self, instance: &str, role: Role, purpose: &str) -> &mut Tool {
        self.runs.entry(instance.into()).or_insert_with(|| {
            self.order.push(instance.into());
            Tool {
                role,
                purpose: purpose.into(),
                clock: RunClock::default(),
                provider: None,
                model: None,
                thread_url: None,
                ended: false,
                outcome: None,
                shown: None,
            }
        })
    }
}

impl Tool {
    fn record_report(&mut self, at: Option<u64>, sent_at_ms: u64, outcome: Option<Outcome>) {
        if let Some(at) = at {
            self.clock.reported(at, Some(sent_at_ms));
        }
        if let Some(outcome) = outcome {
            self.outcome = Some(outcome);
        }
    }

    fn fill_participant(
        &mut self,
        provider: Option<Provider>,
        model: Option<&str>,
        url: Option<&str>,
    ) {
        self.provider = self.provider.or(provider);
        if self.model.is_none() {
            self.model = model.map(str::to_owned);
        }
        if self.thread_url.is_none() {
            self.thread_url = url.map(str::to_owned);
        }
    }

    fn render(
        &mut self,
        instance: &str,
        activity: Option<&Activity>,
        answer: Option<&str>,
        structured: bool,
        replay: bool,
    ) -> Option<Value> {
        let role = match self.role {
            Role::Worker => "Worker",
            Role::Reviewer => "Reviewer",
        };
        let mut title = role.to_owned();
        if let Some(provider) = self.provider {
            let _ = write!(title, " · {}", provider_label(provider));
        }
        if let Some(model) = &self.model {
            let _ = write!(title, " / {model}");
        }
        if let Some(start) = self.clock.started_at_ms.and_then(start_time) {
            let _ = write!(title, " · {start}");
        }
        if let Some(elapsed) = self.clock.elapsed_ms() {
            let _ = write!(title, " · {}", duration(elapsed));
        }
        let mut lines = Vec::new();
        if let Some(url) = &self.thread_url {
            let role = role.to_ascii_lowercase();
            lines.push(format!("[Open {role}]({url})"));
        }
        if let Some(outcome) = &self.outcome {
            lines.push(outcome_text(outcome, answer));
        } else if !self.ended {
            lines.push(
                activity.map_or_else(|| self.purpose.clone(), |activity| activity.label.clone()),
            );
        }
        let status = match self.outcome {
            Some(Outcome::Blocked { .. }) => "failed",
            _ if self.ended || self.outcome.is_some() => "completed",
            _ => "in_progress",
        };
        let card = Card {
            title,
            status,
            lines,
        };
        if !replay && self.shown.as_ref() == Some(&card) {
            return None;
        }
        let update = if structured {
            let kind = if self.shown.is_some() {
                "tool_call_update"
            } else {
                "tool_call"
            };
            let content = card
                .lines
                .iter()
                .map(|text| {
                    json!({
                        "type":"content","content":{"type":"text","text":text}
                    })
                })
                .collect::<Vec<_>>();
            Some(json!({"sessionUpdate":kind,"toolCallId":instance,
                "title":card.title,"kind":"other","status":card.status,"content":content}))
        } else if self
            .shown
            .as_ref()
            .is_none_or(|shown| shown.status == "in_progress")
            && let Some(outcome) = &self.outcome
        {
            Some(message(&outcome_text(outcome, answer)))
        } else {
            None
        };
        self.shown = Some(card);
        update
    }
}

fn outcome_text(outcome: &Outcome, answer: Option<&str>) -> String {
    match outcome {
        Outcome::Work {
            url,
            summary,
            revision,
        } => {
            let status = if *revision {
                "Ready for another review"
            } else {
                "Ready for review"
            };
            let pr = pr_link(url);
            match summary.as_deref().filter(|summary| !summary.is_empty()) {
                Some(summary) => format!("{status} · {pr}\n\n{summary}"),
                None => format!("{status} · {pr}"),
            }
        }
        Outcome::Review {
            decision,
            summary,
            finding_titles,
            change_url,
        } => {
            let mut line = match decision {
                Review::Approve => "Approved".to_owned(),
                Review::Changes => "Changes requested".to_owned(),
            };
            if let Some(url) = change_url {
                let _ = write!(line, " · [Reviewed change]({url})");
            }
            if *decision == Review::Changes && !finding_titles.is_empty() {
                let _ = write!(line, "\n\n{}", finding_titles.join(" · "));
            } else if !summary.trim().is_empty() {
                let _ = write!(line, "\n\n{summary}");
            }
            line
        }
        Outcome::Report { summary } => format!("Report ready\n\n{summary}"),
        Outcome::Blocked { reason } => format!("Blocked · {reason}"),
        Outcome::Question { question } => {
            let status = match (question, answer) {
                (Question::Retry { .. }, _) => "Blocked",
                (_, Some(_)) => "Needs a planner decision",
                (_, None) => "Planner question",
            };
            let mut line = format!("{status}\n\n{}", question_summary(question));
            if let Some(answer) = answer {
                let _ = write!(line, "\n\n{answer}");
            }
            line
        }
    }
}

fn finish(detail: &Detail, merged: bool) -> String {
    let pr = detail.pull_request.as_ref().map(|pr| pr_link(&pr.url));
    let mut text = match (detail.phase, merged, pr) {
        (Phase::Cancelled, _, _) => "Task cancelled".into(),
        (_, true, Some(pr)) => format!("Merged {pr} and closed"),
        (_, true, None) => "Merged and closed".into(),
        (_, _, _)
            if detail
                .report
                .as_ref()
                .is_some_and(|report| report.delivery.is_some()) =>
        {
            "Report closed".into()
        }
        (_, _, Some(pr)) => format!("Closed · {pr}"),
        _ => "Task closed".into(),
    };
    if let Some(elapsed) = detail
        .lifecycle
        .finished_at_ms
        .zip(detail.lifecycle.admitted_at_ms)
        .and_then(|(finished, admitted)| finished.checked_sub(admitted))
    {
        let _ = write!(text, " · {}", duration(elapsed));
    }
    if let Some(rounds) = detail.lifecycle.completed_reviews {
        let suffix = if rounds == 1 { "" } else { "s" };
        let _ = write!(text, " · {rounds} review round{suffix}");
    }
    text
}

fn pr_link(url: &str) -> String {
    let number = url
        .rsplit('/')
        .next()
        .and_then(|part| part.parse::<u64>().ok());
    number.map_or_else(
        || format!("[Pull request]({url})"),
        |number| format!("[PR #{number}]({url})"),
    )
}

fn start_time(at_ms: u64) -> Option<String> {
    let at = OffsetDateTime::from_unix_timestamp(i64::try_from(at_ms / 1000).ok()?).ok()?;
    Some(format!("{:02}:{:02} UTC", at.hour(), at.minute()))
}

fn duration(ms: u64) -> String {
    let seconds = ms / 1000;
    match seconds {
        0..=59 => format!("{seconds}s"),
        60..=3599 => format!("{}m {}s", seconds / 60, seconds % 60),
        _ => format!("{}h {}m", seconds / 3600, seconds / 60 % 60),
    }
}

const fn provider_label(provider: Provider) -> &'static str {
    match provider {
        Provider::Codex => "Codex",
        Provider::Claude => "Claude",
        Provider::Pi => "Pi",
        Provider::Grok => "Grok",
        Provider::Cursor => "Cursor",
        Provider::Opencode => "OpenCode",
        Provider::Copilot => "Copilot",
        Provider::Omp => "OMP",
        Provider::Antigravity => "Antigravity",
        Provider::Muse => "Muse",
        Provider::Fx => "Fx",
        Provider::Kiro => "Kiro",
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
    if let Some(id) = &detail.plan_scope_id {
        json!({"sessionUpdate":"plan_update","plan":{"type":"items","planId":id,"entries":entries}})
    } else {
        json!({"sessionUpdate":"plan","entries":entries})
    }
}

fn question_summary(question: &Question) -> String {
    static REDACTOR: LazyLock<Redactor> =
        LazyLock::new(|| Redactor::new([], RedactionRules::common()));
    match question {
        Question::Work { prompt, .. } => REDACTOR.redact(prompt).text.chars().take(320).collect(),
        Question::Retry { role: Role::Worker } => "The worker could not finish.".into(),
        Question::Retry {
            role: Role::Reviewer,
        } => "The reviewer could not finish.".into(),
        Question::Accept { .. } => "An external merge needs acceptance.".into(),
        Question::Allowance { used_ms, limit_ms } => format!(
            "The planner can extend the task allowance. Used {} of {} minutes.",
            used_ms / 60_000,
            limit_ms / 60_000
        ),
        Question::Repair(reason) => match reason {
            Repair::PullRequestUnavailable => "The pull request could not be confirmed.",
            Repair::WorkspaceHeadMismatch => "The workspace differs from the pull request head.",
            Repair::RevisionHasSameHead => "The revision still has the previously reviewed head.",
            Repair::MergeBlocked => "GitHub is blocking the merge.",
            Repair::MergeUnconfirmed => "GitHub has not confirmed the merge.",
        }
        .into(),
    }
}

fn answer_action(detail: &Detail) -> String {
    if let Some(url) = &detail.question_url {
        format!("[Read the full question and answer in the planner thread]({url}).")
    } else if detail.operator_inbox {
        "Answer in the pinned Nucleus Inbox.".into()
    } else {
        "Answer in the task controls.".into()
    }
}

pub(crate) fn message(text: &str) -> Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("{text}\n\n")}})
}
