use std::{collections::BTreeMap, fmt::Write as _};

use nucleus_core::{
    Phase, Question, Repair, Review, Role,
    acp::lifecycle::{Outcome, RoleCard, StepState, Transcript},
    profiles::Provider,
};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::client::Detail;

#[derive(Default)]
pub(crate) struct Presentation {
    pub prompt_seen: bool,
    plan: Option<Value>,
    cards: BTreeMap<String, Card>,
    question: Option<Question>,
    finished: bool,
    last_acceptance: Option<i64>,
}

#[derive(PartialEq, Eq)]
struct Card {
    title: String,
    status: &'static str,
    link: Option<String>,
    body: Option<String>,
}

impl Presentation {
    pub(crate) fn update(&mut self, detail: &Detail, structured: bool, replay: bool) -> Vec<Value> {
        let mut updates = Vec::new();
        let replay = replay && detail.plan_scope_id.is_some();
        if structured {
            let plan = plan(detail);
            if replay || self.plan.as_ref() != Some(&plan) {
                updates.push(plan.clone());
                self.plan = Some(plan);
            }
        }
        let empty = Transcript::default();
        let transcript = detail.lifecycle.transcript.as_ref().unwrap_or(&empty);
        for run in &transcript.cards {
            let answer = (transcript.question_owner.as_ref() == Some(&run.instance))
                .then(|| answer_action(transcript, detail.operator_inbox));
            let card = Card::from_run(run, answer.as_deref());
            let previous = self.cards.get(&run.instance);
            if !replay && previous == Some(&card) {
                continue;
            }
            if structured {
                let kind = if previous.is_some() {
                    "tool_call_update"
                } else {
                    "tool_call"
                };
                updates.push(card.update(&run.instance, kind));
            } else if run.outcome.is_some()
                && previous.is_none_or(|shown| shown.status == "in_progress")
                && let Some(body) = &card.body
            {
                updates.push(message(body));
            }
            self.cards.insert(run.instance.clone(), card);
        }
        if transcript.question != self.question {
            if transcript.question_owner.is_none()
                && let Some(question) = &transcript.question
            {
                updates.push(message(&format!(
                    "{}\n\n{}",
                    question_summary(question),
                    answer_action(transcript, detail.operator_inbox)
                )));
            }
            self.question.clone_from(&transcript.question);
        }
        if let Some(last) = self.last_acceptance {
            for (_, reason) in transcript
                .external_acceptances
                .iter()
                .filter(|(sequence, _)| *sequence > last)
            {
                updates.push(message(&format!("External merge accepted. {reason}")));
            }
        }
        self.last_acceptance = Some(
            transcript
                .external_acceptances
                .last()
                .map_or(0, |(sequence, _)| *sequence),
        );
        if detail.phase.is_terminal() && !self.finished {
            updates.push(message(&finish(detail, transcript)));
            self.finished = true;
        }
        updates
    }
}

impl Card {
    fn from_run(run: &RoleCard, answer: Option<&str>) -> Self {
        let role = match run.role {
            Role::Worker => "Worker",
            Role::Reviewer => "Reviewer",
        };
        let mut title = role.to_owned();
        if let Some(provider) = run.provider {
            let _ = write!(title, " · {}", provider_label(provider));
        }
        if let Some(model) = &run.model {
            let _ = write!(title, " / {model}");
        }
        if let Some(start) = run.started_at_ms.and_then(start_time) {
            let _ = write!(title, " · {start}");
        }
        let finished = run.ended || run.outcome.is_some();
        if let Some(elapsed) = run.elapsed_ms {
            let _ = write!(title, " · {}", duration(elapsed));
        } else if finished {
            title.push_str(" · Duration unavailable");
        }
        let status = match run.outcome {
            Some(Outcome::Blocked { .. }) => "failed",
            _ if finished => "completed",
            _ => "in_progress",
        };
        let link = run
            .thread_url
            .as_ref()
            .map(|url| format!("[Open {}]({url})", role.to_ascii_lowercase()));
        let body = match &run.outcome {
            Some(outcome) => Some(outcome_text(outcome, answer)),
            None if !finished => Some(run.activity.as_deref().unwrap_or(&run.purpose).to_owned()),
            None => None,
        };
        Self {
            title,
            status,
            link,
            body,
        }
    }

    fn update(&self, instance: &str, kind: &str) -> Value {
        let content: Vec<_> = self
            .link
            .iter()
            .chain(self.body.iter())
            .map(|text| json!({"type":"content","content":{"type":"text","text":text}}))
            .collect();
        json!({"sessionUpdate":kind,"toolCallId":instance,
            "title":self.title,"kind":"other","status":self.status,"content":content})
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
            let summary = summary
                .as_deref()
                .map(str::trim)
                .filter(|summary| !summary.is_empty())
                .unwrap_or("No change summary supplied.");
            format!("{status} · {pr}\n\n{summary}")
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
        Outcome::Report { summary } => {
            let summary = if summary.trim().is_empty() {
                "No report summary supplied."
            } else {
                summary
            };
            format!("Report ready\n\n{summary}")
        }
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

fn finish(detail: &Detail, transcript: &Transcript) -> String {
    let pr = detail.pull_request.as_ref().map(|pr| pr_link(&pr.url));
    let mut text = match (detail.phase, transcript.merged, pr) {
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
    let rounds = transcript.completed_reviews;
    if rounds > 0 {
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
    match question {
        Question::Work { prompt, .. } => prompt.clone(),
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

fn answer_action(transcript: &Transcript, operator_inbox: bool) -> String {
    if let Some(url) = &transcript.question_url {
        format!("[Read the full question and answer in the planner thread]({url}).")
    } else if operator_inbox {
        "Answer in the pinned Nucleus Inbox.".into()
    } else {
        "Answer in the task controls.".into()
    }
}

pub(crate) fn message(text: &str) -> Value {
    json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("{text}\n\n")}})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_card_names_missing_summary_and_timing() {
        for summary in [None, Some("  ".into())] {
            let run: RoleCard = serde_json::from_value(json!({
                "instance":"fixture-run","role":"worker","purpose":"Fixture work","ended":true,
                "outcome":Outcome::Work {
                    url: "https://github.com/example/fixture/pull/7".into(),
                    summary, revision: false,
                }
            }))
            .unwrap();
            let card = Card::from_run(&run, None);
            assert_eq!(card.title, "Worker · Duration unavailable");
            assert_eq!(card.status, "completed");
            assert_eq!(
                card.body.as_deref(),
                Some(
                    "Ready for review · [PR #7](https://github.com/example/fixture/pull/7)\n\nNo change summary supplied."
                ),
            );
        }
    }
}
