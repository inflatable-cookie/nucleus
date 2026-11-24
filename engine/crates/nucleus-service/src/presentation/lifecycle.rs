use nucleus_core::{
    Phase, Review, Role, Task, Verdict, WaitReason,
    acp::lifecycle::{Lifecycle, Participant, Step, StepKey, StepState, StepTone},
};
use nucleus_store::{Store, StoreError};

use super::{HistoryEvent, Milestone};
use crate::titles::phase_label;

#[derive(Default)]
pub(super) struct Audit {
    finished_at_ms: Option<u64>,
    phase_before_finish: Option<Phase>,
    last_phase: Option<Phase>,
    completed_reviews: u64,
    work_ms: Option<u64>,
    review_ms: Option<u64>,
}

struct SentRun {
    instance: String,
    role: Role,
    sent_at_ms: Option<u64>,
}

impl Audit {
    pub(super) fn read(store: &Store, task: &Task) -> Result<Self, StoreError> {
        let mut audit = Self::default();
        let mut sent: Option<SentRun> = None;
        for event in store.lifecycle_events(&task.identity().id)? {
            let at = u64::try_from(event.content.at).ok();
            let event = HistoryEvent::from(event);
            // Earlier engines recorded send/replay and report times as separate audit rows.
            if let Some(run) = &mut sent {
                if event.event.content.kind == "host_send" {
                    run.sent_at_ms = at;
                }
                if event.event.content.kind == "reported" && event.presentation.is_empty() {
                    audit.record_duration(run, at);
                }
            }

            for record in event.presentation {
                match record {
                    Milestone::RunStarted {
                        instance,
                        role,
                        started_at_ms,
                        ..
                    } => {
                        audit.last_phase = Some(match role {
                            Role::Worker => Phase::Working,
                            Role::Reviewer => Phase::Reviewing,
                        });
                        sent = Some(SentRun {
                            instance,
                            role,
                            sent_at_ms: started_at_ms.or(at),
                        });
                    }
                    Milestone::RunReported {
                        instance,
                        sent_at_ms,
                    } => {
                        if let Some(run) = &mut sent
                            && run.instance == instance
                        {
                            run.sent_at_ms = Some(sent_at_ms);
                            audit.record_duration(run, at);
                        }
                    }
                    Milestone::RunEnded { instance }
                        if sent.as_ref().is_some_and(|run| run.instance == instance) =>
                    {
                        sent = None;
                    }
                    Milestone::PullRequest { .. } => audit.last_phase = Some(Phase::Reviewing),
                    Milestone::Verdict { verdict } => {
                        audit.last_phase = Some(match verdict {
                            Verdict::Reviewed {
                                decision: Review::Changes,
                                ..
                            } => Phase::Working,
                            _ => Phase::Merging,
                        });
                        if event.event.content.kind == "phase_reconciled"
                            && matches!(verdict, Verdict::Reviewed { .. })
                        {
                            audit.completed_reviews += 1;
                        }
                    }
                    Milestone::Merged { .. } => audit.last_phase = Some(Phase::Closing),
                    Milestone::Finished { previous_phase, .. } => {
                        audit.finished_at_ms = at;
                        audit.phase_before_finish = previous_phase.or(audit.last_phase);
                    }
                    _ => {}
                }
            }
        }
        Ok(audit)
    }

    fn record_duration(&mut self, run: &mut SentRun, reported_at_ms: Option<u64>) {
        if let (Some(sent_at_ms), Some(reported_at_ms)) = (run.sent_at_ms.take(), reported_at_ms)
            && let Some(elapsed) = reported_at_ms.checked_sub(sent_at_ms)
        {
            let total = match run.role {
                Role::Worker => &mut self.work_ms,
                Role::Reviewer => &mut self.review_ms,
            };
            *total = Some(total.unwrap_or(0).saturating_add(elapsed));
        }
    }

    pub(super) const fn next_review_round(&self) -> u64 {
        self.completed_reviews.saturating_add(1)
    }
}

pub(crate) fn read(
    task: &Task,
    store: &Store,
    state_label: &str,
    wait: Option<WaitReason>,
    admitted_at_ms: Option<u64>,
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
        Some(audit.completed_reviews).filter(|&round| round > 0)
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
                StepKey::Working => (Some(Role::Worker), audit.work_ms),
                StepKey::Review => (Some(Role::Reviewer), audit.review_ms),
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
        worker: participant(task, Role::Worker),
        reviewer: participant(task, Role::Reviewer),
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

fn participant(task: &Task, role: Role) -> Option<Participant> {
    let threads = task.threads();
    let profile = threads.profile(role);
    Some(Participant {
        thread: threads.get(role)?.into(),
        provider: profile.map(|profile| profile.provider),
        model: profile.map(|profile| profile.model.clone()),
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
