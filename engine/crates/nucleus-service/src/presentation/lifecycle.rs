use nucleus_core::{
    Phase, Review, Role, Task, Verdict, WaitReason,
    acp::lifecycle::{
        Lifecycle, Milestone, Outcome, Participant, RoleCard, Step, StepKey, StepState, StepTone,
        Transcript,
    },
    profiles::Profile,
};
use nucleus_store::{Store, StoreError};

use super::{HistoryEvent, TranscriptRequest, purpose, redact_question};
use crate::titles::phase_label;

#[derive(Default)]
pub(super) struct Audit {
    transcript: Transcript,
    finished_at_ms: Option<u64>,
    phase_before_finish: Option<Phase>,
    last_phase: Option<Phase>,
    sent_at_ms: Option<u64>,
    pull_request_url: Option<String>,
}

impl Audit {
    pub(super) fn read(store: &Store, task: &Task) -> Result<Self, StoreError> {
        let mut audit = Self::default();
        for event in store.lifecycle_events(&task.identity().id)? {
            audit.apply(HistoryEvent::from(event), task);
        }
        Ok(audit)
    }

    #[expect(
        clippy::too_many_lines,
        reason = "fold each lifecycle event in journal order"
    )]
    fn apply(&mut self, event: HistoryEvent, task: &Task) {
        let at = u64::try_from(event.event.content.at).ok();
        let kind = event.event.content.kind.as_str();
        let cards = &mut self.transcript.cards;
        if event.presentation.is_empty()
            && let Some(card) = cards.last_mut().filter(|card| !card.ended)
        {
            match kind {
                "host_send" => self.sent_at_ms = at,
                "reported" => record_duration(card, self.sent_at_ms, at),
                _ => {}
            }
        }
        let mut ended = None;
        for record in event.presentation {
            let cards = &mut self.transcript.cards;
            match record {
                Milestone::RunStarted {
                    instance,
                    role,
                    purpose,
                    thread,
                    provider,
                    model,
                    model_observed,
                    started_at_ms,
                    ..
                } => {
                    self.last_phase = Some(if role == Role::Worker {
                        Phase::Working
                    } else {
                        Phase::Reviewing
                    });
                    self.sent_at_ms = started_at_ms.or(at);
                    cards.push(RoleCard {
                        instance,
                        role,
                        purpose,
                        thread_url: thread.as_deref().and_then(nucleus_hosts::thread_link),
                        provider,
                        provider_instance: None,
                        model,
                        model_observed,
                        started_at_ms: self.sent_at_ms,
                        elapsed_ms: None,
                        ended: false,
                        outcome: None,
                        activity: None,
                    });
                }
                Milestone::RunRouting {
                    instance,
                    provider_instance,
                    provider,
                    model,
                } => {
                    if let Some(card) = cards
                        .iter_mut()
                        .rev()
                        .find(|card| card.instance == instance)
                    {
                        card.provider = provider;
                        card.provider_instance = Some(provider_instance);
                        card.model = Some(model);
                        card.model_observed = true;
                    }
                }
                Milestone::RunReported {
                    instance,
                    sent_at_ms,
                    outcome,
                } => {
                    if let Some(card) = cards.last_mut().filter(|card| card.instance == instance) {
                        record_duration(card, Some(sent_at_ms), at);
                        card.outcome = outcome;
                    }
                }
                Milestone::RunEnded { instance } => {
                    let index = cards.len().checked_sub(1);
                    if let Some(card) = cards.last_mut().filter(|card| card.instance == instance) {
                        card.ended = true;
                        ended = index;
                    }
                }
                Milestone::PullRequest { url } => {
                    self.last_phase = Some(Phase::Reviewing);
                    if let Some(card) = ended
                        .map(|i| &mut cards[i])
                        .filter(|card| card.role == Role::Worker)
                    {
                        card.outcome.get_or_insert_with(|| Outcome::Work {
                            url: url.clone(),
                            summary: None,
                            revision: false,
                        });
                    }
                    self.pull_request_url = Some(url);
                }
                Milestone::Verdict { verdict } => {
                    self.verdict(verdict, &event.event, task, ended);
                }
                Milestone::Question { question } => {
                    if let Some(i) = ended {
                        cards[i]
                            .outcome
                            .get_or_insert(Outcome::Question { question });
                    }
                }
                Milestone::Merged { .. } => {
                    self.last_phase = Some(Phase::Closing);
                    self.transcript.merged = true;
                }
                Milestone::Finished { previous_phase, .. } => {
                    self.finished_at_ms = at;
                    self.phase_before_finish = previous_phase.or(self.last_phase);
                }
            }
        }
    }

    fn verdict(
        &mut self,
        verdict: Verdict,
        event: &nucleus_store::Event,
        task: &Task,
        ended: Option<usize>,
    ) {
        match verdict {
            Verdict::Reviewed {
                head,
                decision,
                summary,
            } => {
                self.last_phase = Some(if decision == Review::Changes {
                    Phase::Working
                } else {
                    Phase::Merging
                });
                if event.content.kind == "phase_reconciled" {
                    self.transcript.completed_reviews += 1;
                }
                if let Some(card) = ended
                    .map(|i| &mut self.transcript.cards[i])
                    .filter(|card| card.role == Role::Reviewer)
                {
                    card.outcome.get_or_insert_with(|| Outcome::Review {
                        decision,
                        summary,
                        finding_titles: Vec::new(),
                        change_url: self
                            .pull_request_url
                            .as_deref()
                            .or_else(|| {
                                task.pull_request()
                                    .filter(|pr| pr.head == head)
                                    .map(|pr| pr.url.as_str())
                            })
                            .map(|url| format!("{}/commits/{head}", url.trim_end_matches('/'))),
                    });
                }
            }
            Verdict::Accepted { acceptance, .. } => {
                self.last_phase = Some(Phase::Merging);
                self.transcript
                    .external_acceptances
                    .push((event.sequence, acceptance.reason));
            }
        }
    }

    pub(super) const fn next_review_round(&self) -> u64 {
        self.transcript.completed_reviews.saturating_add(1)
    }

    fn elapsed(&self, role: Role) -> Option<u64> {
        self.transcript
            .cards
            .iter()
            .filter(|card| card.role == role)
            .filter_map(|card| card.elapsed_ms)
            .reduce(u64::saturating_add)
    }

    fn transcript(
        mut self,
        task: &Task,
        review_round: Option<u64>,
        request: TranscriptRequest<'_>,
    ) -> Transcript {
        let cards = &mut self.transcript.cards;
        if let Some(run) = task.run()
            && let Some(sent) = run.last_send_at_ms()
        {
            let launch = run.launch();
            if cards
                .last()
                .is_none_or(|card| card.instance != launch.instance)
            {
                cards.push(RoleCard {
                    instance: launch.instance.clone(),
                    role: launch.role,
                    purpose: purpose(task, launch.role, review_round),
                    thread_url: None,
                    provider: None,
                    provider_instance: None,
                    model: None,
                    model_observed: false,
                    started_at_ms: Some(sent),
                    elapsed_ms: None,
                    ended: false,
                    outcome: None,
                    activity: None,
                });
            }
            if let Some(card) = cards.last_mut() {
                bind_card(card, &launch.thread, launch.profile());
                card.started_at_ms.get_or_insert(sent);
                card.activity = request.activity.map(str::to_owned);
            }
        }
        for role in [Role::Worker, Role::Reviewer] {
            let Some(thread) = task.threads().get(role) else {
                continue;
            };
            let Some(origin) = nucleus_hosts::child_origin_instance(thread) else {
                continue;
            };
            if let Some(card) = cards
                .iter_mut()
                .find(|card| card.role == role && card.instance == origin)
            {
                bind_card(card, thread, task.threads().profile(role));
            }
        }
        self.transcript.question = task.question().cloned();
        self.transcript.question_url = task
            .question_delivery()
            .filter(|delivery| delivery.last_send_at_ms.is_some())
            .and_then(|delivery| nucleus_hosts::thread_link(&delivery.thread));
        if let Some(question) = &mut self.transcript.question {
            redact_question(question);
            self.transcript.question_owner = cards.iter().rev()
                .find(|card| matches!(&card.outcome, Some(Outcome::Question { question: asked }) if asked == question))
                .map(|card| card.instance.clone());
        }
        self.transcript
    }
}

fn bind_card(card: &mut RoleCard, thread: &str, profile: Option<&Profile>) {
    if card.thread_url.is_none() {
        card.thread_url = nucleus_hosts::thread_link(thread);
    }
    if !card.model_observed
        && let Some(profile) = profile
    {
        card.provider.get_or_insert(profile.provider);
        card.model.get_or_insert_with(|| profile.model.clone());
    }
}

fn record_duration(card: &mut RoleCard, sent: Option<u64>, reported: Option<u64>) {
    if card.elapsed_ms.is_none() {
        card.elapsed_ms = reported
            .zip(sent)
            .and_then(|(reported, sent)| reported.checked_sub(sent));
    }
}

pub(crate) fn read(
    task: &Task,
    store: &Store,
    state_label: &str,
    wait: Option<WaitReason>,
    admitted_at_ms: Option<u64>,
    transcript: Option<TranscriptRequest<'_>>,
) -> Result<Lifecycle, StoreError> {
    let audit = Audit::read(store, task)?;
    let phase = task.phase();
    let report_only = task.report_task().is_some();
    let step_phase = if phase == Phase::Cancelled {
        audit.phase_before_finish.unwrap_or(Phase::Queued)
    } else {
        phase
    };
    let current = step_key(step_phase, report_only);
    let keys = if report_only {
        &[
            StepKey::Queued,
            StepKey::Working,
            StepKey::ReportReady,
            StepKey::Done,
        ][..]
    } else {
        &[
            StepKey::Queued,
            StepKey::Working,
            StepKey::Review,
            StepKey::Merge,
            StepKey::Close,
        ][..]
    };
    let review_round = if report_only {
        None
    } else if step_phase == Phase::Reviewing {
        Some(audit.next_review_round())
    } else {
        Some(audit.transcript.completed_reviews).filter(|&round| round > 0)
    };
    let active_run = task
        .run()
        .filter(|run| !phase.is_terminal() && !run.revoked() && run.report().is_none());
    let mut reached_current = false;
    let archiving = phase == Phase::Done && wait == Some(WaitReason::Stopping);
    let steps = keys
        .iter()
        .copied()
        .map(|key| {
            let state =
                if (phase == Phase::Done && !archiving) || (!reached_current && key != current) {
                    StepState::Done
                } else if key == current {
                    StepState::Current
                } else {
                    StepState::Todo
                };
            reached_current |= key == current;
            let tone = match state {
                StepState::Done => StepTone::Success,
                StepState::Todo => StepTone::Muted,
                StepState::Current => current_tone(phase, wait),
            };
            let (role, elapsed_ms) = match key {
                StepKey::Working => (Some(Role::Worker), audit.elapsed(Role::Worker)),
                StepKey::Review => (Some(Role::Reviewer), audit.elapsed(Role::Reviewer)),
                _ => (None, None),
            };
            let active_since_ms = active_run
                .filter(|run| Some(run.launch().role) == role && state == StepState::Current)
                .and_then(nucleus_core::Run::last_send_at_ms);
            let round_label = review_round
                .filter(|_| key == StepKey::Review)
                .map(|round| format!("Round {round}"));
            let note = if state == StepState::Current {
                current_note(task, key, state_label)
            } else {
                None
            };
            Step {
                key,
                label: key.label().into(),
                state,
                tone,
                note,
                round_label,
                elapsed_ms,
                active_since_ms,
            }
        })
        .collect();
    Ok(Lifecycle {
        steps,
        admitted_at_ms,
        finished_at_ms: audit.finished_at_ms.filter(|_| phase.is_terminal()),
        review_round,
        worker: participant(task, Role::Worker, &audit),
        reviewer: participant(task, Role::Reviewer, &audit),
        transcript: transcript.map(|request| audit.transcript(task, review_round, request)),
    })
}

const fn current_tone(phase: Phase, wait: Option<WaitReason>) -> StepTone {
    match (phase, wait) {
        (Phase::Cancelled, _) => StepTone::Muted,
        (Phase::Blocked | Phase::Error, _)
        | (_, Some(WaitReason::HostObservationBlocked | WaitReason::AssignmentTooLarge)) => {
            StepTone::Danger
        }
        (
            _,
            Some(
                WaitReason::Hold
                | WaitReason::Question
                | WaitReason::OperatorDeclined
                | WaitReason::Permission
                | WaitReason::UsagePermission
                | WaitReason::Input,
            ),
        ) => StepTone::Warning,
        _ => StepTone::Accent,
    }
}

fn current_note(task: &Task, step: StepKey, state_label: &str) -> Option<String> {
    let is_step_label = state_label == step.label()
        || (matches!(step, StepKey::Review | StepKey::Merge | StepKey::Close)
            && !task.phase().is_terminal()
            && state_label == phase_label(task));
    (!is_step_label).then(|| state_label.to_owned())
}

fn participant(task: &Task, role: Role, audit: &Audit) -> Option<Participant> {
    let threads = task.threads();
    let profile = threads.profile(role);
    let thread = threads.get(role)?;
    let url = nucleus_hosts::thread_link(thread);
    let current = task
        .run()
        .filter(|run| run.launch().role == role)
        .map(|run| run.launch().instance.as_str());
    let observed = audit
        .transcript
        .cards
        .iter()
        .rev()
        .find(|card| {
            card.role == role
                && card.thread_url == url
                && current.is_none_or(|instance| card.instance == instance)
        })
        .filter(|card| card.model_observed);
    Some(Participant {
        thread: thread.into(),
        provider: observed.map_or_else(
            || profile.map(|profile| profile.provider),
            |card| card.provider,
        ),
        provider_instance: observed.and_then(|card| card.provider_instance.clone()),
        model: observed.map_or_else(
            || profile.map(|profile| profile.model.clone()),
            |card| card.model.clone(),
        ),
    })
}

const fn step_key(phase: Phase, report_only: bool) -> StepKey {
    match phase {
        Phase::Queued | Phase::Cancelled => StepKey::Queued,
        Phase::Working | Phase::Blocked | Phase::Error => StepKey::Working,
        Phase::Reviewing => StepKey::Review,
        Phase::Merging => StepKey::Merge,
        Phase::ReportReady => StepKey::ReportReady,
        Phase::Done if report_only => StepKey::Done,
        Phase::Closing | Phase::Done => StepKey::Close,
    }
}
