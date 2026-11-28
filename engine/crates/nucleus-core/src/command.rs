use std::{fmt, num::NonZeroU64};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::decision::{
    Action, CloseWorkspace, Forge, Launch, Observation, Observed, RunState, decide,
};
use crate::model::{
    Acceptance, Authority, Brief, CallbackCredential, CredentialDigest, Head, Hold, HoldBy,
    LaunchInputs, OpenQuestion, Phase, PreparedLaunch, Question, Repair, Report, ReportAcceptance,
    ReportArtifact, ReportReceipt, Role, Run, Task, Verdict, WorkContinuation,
};
use crate::profiles::{BriefPolicy, ProfileLaunch};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    Move(Phase),
    MoveWork {
        instruction: String,
    },
    Complete {
        version: i64,
        artifact: ReportArtifact,
        reason: String,
    },
    Answer(Answer),
    Cancel,
    Amend(String),
    Hold(String),
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Answer {
    Work(String),
    Retry,
    Extend,
    Accept { head: Head, reason: String },
}

impl Question {
    /// The CLI answer accepted for this question, following the task reference.
    #[must_use]
    pub const fn answer_form(&self) -> &'static str {
        match self {
            Self::Work { .. } | Self::Repair(_) => "work TEXT",
            Self::Retry { .. } => "retry",
            Self::Allowance { .. } => "extend",
            Self::Accept { .. } => "accept HEAD REASON",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    HeadUnverified,
    HeadChanged,
    MergeAuthorityRequired,
    MergedHeadRequired,
    AnswerDoesNotMatch,
    ExpectedAnswer(&'static str),
    AcceptanceReasonRequired,
    OperatorRequired,
    BriefVersionsExhausted,
    LaunchSequenceExhausted,
    LaunchNoLongerApplies,
    InvalidReportCredential,
    ReportDoesNotMatch,
    ReportAlreadyReceived,
    ReportPolicyChanged,
    QueuePriorityChanged,
    MergeHoldOwner,
    MergeHoldChangeTooLate,
    ReportOwnerAction,
    ReportAcceptanceMismatch,
    ReportInstructionRequired,
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::HeadUnverified => "waiting to check the current PR head",
            Self::HeadChanged => "the current PR head no longer matches the task",
            Self::MergeAuthorityRequired => "the current PR head needs approval or acceptance",
            Self::MergedHeadRequired => "the current PR head needs a confirmed merge",
            Self::AnswerDoesNotMatch => "the answer does not match the current question",
            Self::ExpectedAnswer(form) => {
                return write!(
                    formatter,
                    "the answer does not match the current question. Use nucleus answer REF {form}"
                );
            }
            Self::AcceptanceReasonRequired => "accept requires a nonblank reason",
            Self::OperatorRequired => "the operator must accept the head of a review entry",
            Self::BriefVersionsExhausted => "the brief version cannot be incremented",
            Self::LaunchSequenceExhausted => "the launch sequence cannot be incremented",
            Self::LaunchNoLongerApplies => {
                "the launch does not match the current task and observation"
            }
            Self::InvalidReportCredential => {
                "the report does not authenticate against the current run"
            }
            Self::ReportDoesNotMatch => "the report does not match the current role or review head",
            Self::ReportAlreadyReceived => "the run already sent a different report",
            Self::ReportPolicyChanged => {
                "amend cannot change report-only delivery or its attached lanes; resubmit"
            }
            Self::QueuePriorityChanged => {
                "queue.priority is read at admission only; use promote or demote commands"
            }
            Self::MergeHoldOwner => "the planner who placed the merge hold or the operator must release it",
            Self::MergeHoldChangeTooLate => "the brief's merge hold cannot change once merging has started; use nucleus release REF to lift it",
            Self::ReportOwnerAction => {
                "use complete to accept the delivered report or move to work with an instruction"
            }
            Self::ReportAcceptanceMismatch => {
                "complete requires a reason and the exact artifact delivered by this task"
            }
            Self::ReportInstructionRequired => "move to work requires an instruction",
        })
    }
}

impl std::error::Error for CommandError {}

impl Task {
    /// Apply local decisions against the same observation that justified them.
    /// External effects remain the service's responsibility.
    pub fn reconcile(&mut self, observation: &Observation) -> Action {
        let action = decide(self, observation);
        match &action {
            Action::Advance(phase) => self.advance(*phase, observation),
            Action::Revoke => {
                if let Some(run) = &mut self.run {
                    run.revoked = true;
                }
            }
            Action::Relaunch(_) => {
                self.settle_run(observation);
                self.attempts += 1;
            }
            Action::Ask(question) => {
                self.settle_run(observation);
                if let Some(pr) = observation.pr() {
                    self.observe_pr(pr);
                }
                if matches!(question, Question::Retry { .. }) {
                    self.attempts = 3;
                }
                self.question = Some(OpenQuestion {
                    head: self.pr.as_ref().map(|pr| pr.head.clone()),
                    question: question.clone(),
                    delivery: None,
                    operator_decline: None,
                });
            }
            Action::Launch { .. }
            | Action::RemindReport
            | Action::Wait(_)
            | Action::Merge { .. }
            | Action::Close { .. }
            | Action::Nothing => {}
        }
        action
    }

    /// Observe an external merge whose pending report has no published approval.
    /// Retain any previously applied authority, or ask for explicit acceptance.
    #[must_use]
    pub fn reconcile_external_merge_without_pending_review(
        &mut self,
        observation: &Observation,
    ) -> Action {
        if matches!(observation.forge, Observed::Known(Forge::Merged { .. }))
            && self.run().is_some_and(|run| {
                !run.revoked() && matches!(run.report(), Some(Report::Review { .. }))
            })
        {
            self.settle_run(observation);
        }
        self.reconcile(observation)
    }

    fn advance(&mut self, phase: Phase, observation: &Observation) {
        if observation.resolves_repair(self) {
            self.question = None;
        }
        let run = self.settle_run(observation);
        if run.as_ref().is_some_and(|run| run.revoked) {
            return;
        }
        if self.phase != phase {
            self.threads.missing_report_from = None;
        }
        let reminder_cause = run
            .as_ref()
            .filter(|run| run.report_reminder_for().is_some() && run.report.is_none())
            .and_then(|run| {
                let state = observation.current(&run.launch.instance)?;
                Some(crate::decision::missing_report_cause(
                    run.launch.role,
                    state,
                ))
            });
        let report = run.and_then(|run| run.report);
        if let Some(state) = &mut self.report_state {
            if let Some(report) = report {
                match report {
                    Report::ReportReady(delivery) => state.delivery = Some(delivery),
                    Report::Blocked(failure) | Report::Error(failure) => {
                        state.failure = Some(failure.summary);
                    }
                    _ => {}
                }
            } else if phase == Phase::Blocked {
                state.failure = Some(self.threads.last_provider_limit.clone().or(reminder_cause).map_or_else(
                    || "The worker did not deliver an authenticated report.".into(),
                    |cause| {
                        format!(
                            "{cause} Inspect the retained thread and use Move to work to retry."
                        )
                    },
                ));
            }
            self.phase = phase;
            self.attempts = 0;
            return;
        }
        if let Some(pr) = observation.pr() {
            self.observe_pr(pr);
        }
        if phase != Phase::Reviewing {
            self.threads.same_head_revision_summary = None;
        } else if let Some(Report::Work(work)) = &report
            && self.changes_requested_at(&work.pull_request.head)
        {
            self.threads
                .same_head_revision_summary
                .clone_from(&work.summary);
        }
        if phase == Phase::Reviewing
            && let (Some(author), Some(Report::Work(work))) =
                (&mut self.threads.review_author, &report)
            && self.pr.as_ref() == Some(&work.pull_request)
        {
            author.worker_head = Some(work.pull_request.head.clone());
        }
        if phase == Phase::Working
            && let Some((head, instruction)) = observation.merge_recovery(self)
        {
            self.request_work(instruction, Some(head.clone()));
            return;
        }
        if phase != Phase::Working {
            self.work_continuation = None;
        }
        if let Some(Report::Review {
            head,
            decision,
            summary,
            ..
        }) = report
            && self.pr.as_ref().is_some_and(|pr| pr.head == head)
        {
            self.threads.applied_review_sequence = Some(self.threads.launch_sequence);
            self.verdict = Some(Verdict::Reviewed {
                head,
                decision,
                summary,
            });
        }
        if self.phase != phase {
            self.attempts = 0;
            self.phase = phase;
        }
    }

    fn settle_run(&mut self, observation: &Observation) -> Option<Run> {
        let run = self.run.take()?;
        self.threads.last_provider_limit = match &observation.host {
            Observed::Known(crate::Host::ProviderLimited { instance, cause })
                if instance == &run.launch.instance && run.report.is_none() && !run.revoked =>
            {
                Some(cause.clone())
            }
            _ => None,
        };
        // An older writer kept the preceding settled path while the next role ran.
        // Its one report reminder, if any, also consumed a launch sequence.
        if let Some(previous) = self.threads.settled_scratch.take()
            && let Some(sequence) = self
                .threads
                .launch_sequence
                .checked_sub(1 + u64::from(run.report_reminder_for.is_some()))
            && sequence > 0
        {
            self.threads
                .earlier_scratch
                .entry(sequence)
                .or_insert(previous);
        }
        self.threads.settled_scratch.clone_from(&run.launch.scratch);
        if let Some(state) = &mut self.report_state
            && let Some(head) = run.report.as_ref().and_then(Report::source_head)
            && !state.reported_heads.contains(head)
        {
            state.reported_heads.push(head.clone());
        }
        if (!run.revoked && run.report.is_some())
            || observation
                .current(&run.launch.instance)
                .is_some_and(RunState::ended)
        {
            self.threads.bind(&run.launch);
        }
        Some(run)
    }

    /// Finish closeout with fresh evidence after any requested workspace removal.
    /// Returns whether the task closed.
    pub fn finish_close(&mut self, observation: &Observation) -> bool {
        if matches!(
            decide(self, observation),
            Action::Close {
                workspace: CloseWorkspace::AlreadyAbsent | CloseWorkspace::Retain,
                ..
            }
        ) {
            self.advance(Phase::Done, observation);
            true
        } else {
            false
        }
    }

    /// Retire the authority for the exact head GitHub refused as mismatched.
    /// Keep the binding in Merging while the forge still shows the old head.
    #[must_use]
    pub fn merge_head_mismatched(&mut self, attempted: &Head) -> bool {
        if self.phase != Phase::Merging
            || self.run.is_some()
            || !self.approves(attempted)
            || !self.pr.as_ref().is_some_and(|pr| &pr.head == attempted)
        {
            return false;
        }
        self.verdict = None;
        self.attempts = 0;
        true
    }

    /// Reserve a new run before sending it to T3, freezing the selected profile
    /// and the subscription it charges with the adapter's prepared wire. The
    /// task assigns a new instance and derives its bearer from the supplied
    /// random seed. Keep the bearer in the owner-only ticket. The same durable
    /// reservation owns both the first send and a verified replay.
    ///
    /// # Errors
    /// Returns an error if the launch no longer applies or IDs are exhausted.
    pub fn reserve_grouped_launch(
        &mut self,
        observation: &Observation,
        inputs: LaunchInputs,
        seed: &[u8; 32],
        intent: Option<ProfileLaunch>,
        group: String,
    ) -> Result<CallbackCredential, CommandError> {
        let Action::Launch { role, via } = decide(self, observation) else {
            return Err(CommandError::LaunchNoLongerApplies);
        };
        let (via, profile) = if let Some(intent) = intent {
            if intent.role != role
                || intent.previous != via
                || intent.instance != self.next_launch_instance()?
                || intent.brief != self.brief
                || intent.pr != self.pr
                || intent.findings.as_deref() != crate::profiles::applied_changes(self, observation)
            {
                return Err(CommandError::LaunchNoLongerApplies);
            }
            (intent.via, Some(intent.profile))
        } else {
            (via, None)
        };
        let valid_thread = match via {
            Launch::Create => self.threads.get(role) != Some(inputs.thread.as_str()),
            Launch::Continue { thread } => inputs.thread == thread,
            Launch::SendPrepared => false,
        };
        if !valid_thread || self.threads.get(role.other()) == Some(inputs.thread.as_str()) {
            return Err(CommandError::LaunchNoLongerApplies);
        }
        let sequence = self.next_launch_sequence()?;
        let id = &self.identity.id;
        let instance = self.launch_instance(sequence);
        let (phase, review_head) = match role {
            Role::Worker => ("working", None),
            Role::Reviewer => ("reviewing", observation.pr().map(|pr| pr.head.clone())),
        };
        let head = observation.pr().map_or("none", |pr| pr.head.as_str());
        let label = format!("task-{id}-{phase}-{head}-{}", self.attempts);
        let bearer = launch_credential(seed, &instance);
        if let Some(path) = self.threads.settled_scratch.take() {
            self.threads
                .earlier_scratch
                .insert(self.threads.launch_sequence, path);
        }
        self.threads.launch_sequence = sequence;
        self.run = Some(Run {
            launch: PreparedLaunch {
                instance,
                thread: inputs.thread,
                role,
                label,
                started_at: inputs.started_at,
                credential: CredentialDigest(Sha256::digest(bearer.as_bytes()).into()),
                input: inputs.input,
                review_head,
                scratch: inputs.scratch,
                profile,
                subscription_group: Some(group),
            },
            report: None,
            revoked: false,
            last_send_at_ms: None,
            rejected_awaiting_archive: false,
            report_reminder_for: None,
        });
        Ok(bearer)
    }

    /// Reserve a report-only continuation on the exact role thread. The prior
    /// callback remains authoritative until this reservation is committed.
    ///
    /// # Errors
    /// Returns an error unless the exact terminal run still needs its reminder.
    pub fn reserve_report_reminder(
        &mut self,
        observation: &Observation,
        inputs: LaunchInputs,
        seed: &[u8; 32],
    ) -> Result<CallbackCredential, CommandError> {
        if decide(self, observation) != Action::RemindReport {
            return Err(CommandError::LaunchNoLongerApplies);
        }
        let prior = self
            .run
            .as_ref()
            .ok_or(CommandError::LaunchNoLongerApplies)?;
        if prior.launch.thread != inputs.thread {
            return Err(CommandError::LaunchNoLongerApplies);
        }
        let sequence = self.next_launch_sequence()?;
        let instance = self.launch_instance(sequence);
        let bearer = launch_credential(seed, &instance);
        let mut launch = prior.launch.clone();
        let original = std::mem::replace(&mut launch.instance, instance);
        launch.started_at = inputs.started_at;
        launch.credential = CredentialDigest(Sha256::digest(bearer.as_bytes()).into());
        launch.input = inputs.input;
        launch.scratch = inputs.scratch;
        self.threads.bind(&launch);
        if let Some(path) = &prior.launch.scratch {
            self.threads
                .earlier_scratch
                .insert(self.threads.launch_sequence, path.clone());
        }
        self.threads.launch_sequence = sequence;
        self.run = Some(Run {
            launch,
            report: None,
            revoked: false,
            last_send_at_ms: None,
            rejected_awaiting_archive: false,
            report_reminder_for: Some(original),
        });
        Ok(bearer)
    }

    /// Retire a proven unsent reservation so another subscription can be selected.
    pub fn discard_paused_reservation(&mut self, observation: &Observation) -> bool {
        let Some(run) = self.run.as_ref().filter(|run| {
            !run.revoked
                && run.last_send_at_ms.is_none()
                && run.report.is_none()
                && observation.current(&run.launch.instance) == Some(RunState::ReadyToSend)
        }) else {
            return false;
        };
        if let Some(original) = &run.report_reminder_for {
            self.threads.missing_report_from = Some(original.clone());
        }
        self.run = None;
        true
    }

    /// Obtain the ID the next reservation will use so the caller can freeze its wire.
    ///
    /// # Errors
    /// Returns an error when the launch sequence is exhausted.
    pub fn next_launch_instance(&self) -> Result<String, CommandError> {
        Ok(self.launch_instance(self.next_launch_sequence()?))
    }

    /// Earlier run instances and their durable scratch bindings, newest first.
    pub fn earlier_run_scratch(&self) -> impl Iterator<Item = (String, Option<&std::path::Path>)> {
        (1..self.threads.launch_sequence).rev().map(|sequence| {
            (
                self.launch_instance(sequence),
                self.threads
                    .earlier_scratch
                    .get(&sequence)
                    .map(std::path::PathBuf::as_path),
            )
        })
    }

    /// Last run and its recorded scratch directory for checkout retirement.
    #[must_use]
    pub fn settled_scratch(&self) -> Option<(String, Option<&std::path::Path>)> {
        (self.threads.launch_sequence > 0).then(|| {
            (
                self.launch_instance(self.threads.launch_sequence),
                self.threads.settled_scratch.as_deref(),
            )
        })
    }

    /// The immutable run instance whose review was applied to the task.
    #[must_use]
    pub fn applied_review_instance(&self) -> Option<String> {
        self.threads
            .applied_review_sequence
            .map(|sequence| self.launch_instance(sequence))
    }

    fn launch_instance(&self, sequence: u64) -> String {
        format!("task-{}-run-{sequence}", self.identity.id)
    }

    fn next_launch_sequence(&self) -> Result<u64, CommandError> {
        self.threads
            .launch_sequence
            .checked_add(1)
            .ok_or(CommandError::LaunchSequenceExhausted)
    }

    /// Record a possible native write. Persist this update before the write, even
    /// on a replay used to settle a revoked run. Times are Unix milliseconds.
    ///
    /// # Errors
    /// Returns an error if the run was replaced or the timestamp went backwards.
    pub fn record_send(&mut self, instance: &str, now_ms: u64) -> Result<(), CommandError> {
        let run = self
            .run
            .as_mut()
            .filter(|run| run.launch.instance == instance)
            .ok_or(CommandError::LaunchNoLongerApplies)?;
        if run.rejected_awaiting_archive || run.last_send_at_ms.is_some_and(|prior| prior >= now_ms)
        {
            return Err(CommandError::LaunchNoLongerApplies);
        }
        run.last_send_at_ms = Some(now_ms);
        self.threads.bind(&run.launch);
        self.threads.missing_report_from = None;
        Ok(())
    }

    /// Keep a confirmed rejection while the revoked review's archive is read back.
    /// # Errors
    /// Returns an error if this was not a possibly sent, revoked review.
    pub fn record_rejected_stop(&mut self, instance: &str) -> Result<(), CommandError> {
        let run = self
            .run
            .as_mut()
            .filter(|run| {
                run.launch.instance == instance
                    && run.revoked
                    && run.launch.role == Role::Reviewer
                    && run.last_send_at_ms.is_some()
            })
            .ok_or(CommandError::LaunchNoLongerApplies)?;
        run.rejected_awaiting_archive = true;
        Ok(())
    }

    /// Keep one authenticated report until the service observes the turn settle.
    /// An identical retry is harmless while the same run is current.
    ///
    /// # Errors
    /// Returns an error for an obsolete credential, a report for a different
    /// role or head, or a conflicting second report.
    pub fn record_report(
        &mut self,
        instance: &str,
        credential: &[u8; 32],
        report: Report,
    ) -> Result<(), CommandError> {
        if self.replay_report(instance, credential, &report)? {
            return Ok(());
        }
        let active = self.authenticate_run(instance, credential)?;
        let role = active.launch.role;
        if self.report_state.is_some() && active.last_send_at_ms.is_none() {
            return Err(CommandError::InvalidReportCredential);
        }
        match (&report, role, self.report_state.as_ref()) {
            (Report::Question { .. }, _, None)
            | (Report::Work(_), Role::Worker, None)
            | (Report::Blocked(_) | Report::Error(_), Role::Worker, Some(_)) => {}
            (Report::ReportReady(delivery), Role::Worker, Some(state))
                if delivery.artifact.key == state.lane => {}
            (Report::Review { head, .. }, Role::Reviewer, None)
                if self
                    .run
                    .as_ref()
                    .and_then(|run| run.launch.review_head.as_ref())
                    == Some(head) => {}
            _ => return Err(CommandError::ReportDoesNotMatch),
        }
        let run = self
            .run
            .as_mut()
            .ok_or(CommandError::InvalidReportCredential)?;
        match &run.report {
            Some(prior) if prior != &report => Err(CommandError::ReportAlreadyReceived),
            Some(_) => Ok(()),
            None => {
                if let Some(state) = &mut self.report_state {
                    state.receipts.push(ReportReceipt {
                        instance: instance.into(),
                        credential: run.launch.credential.clone(),
                        report: report.clone(),
                    });
                }
                run.report = Some(report);
                Ok(())
            }
        }
    }

    /// Check an already accepted callback without regranting lane or run authority.
    ///
    /// # Errors
    /// Returns an error when an authenticated attempt conflicts with its receipt.
    pub fn replay_report(
        &self,
        instance: &str,
        credential: &[u8; 32],
        report: &Report,
    ) -> Result<bool, CommandError> {
        let Some(receipt) = self.report_state.as_ref().and_then(|state| {
            state
                .receipts
                .iter()
                .find(|receipt| receipt.instance == instance)
        }) else {
            return Ok(false);
        };
        let digest: [u8; 32] = Sha256::digest(credential).into();
        if !bool::from(receipt.credential.0.ct_eq(&digest)) {
            return Err(CommandError::InvalidReportCredential);
        }
        if receipt.report != *report {
            return Err(CommandError::ReportAlreadyReceived);
        }
        Ok(true)
    }

    /// Authenticate a bearer against the current unrevoked run, without granting owner authority.
    ///
    /// # Errors
    /// Returns an error when the instance or bearer no longer matches.
    pub fn authenticate_run(
        &self,
        instance: &str,
        credential: &[u8; 32],
    ) -> Result<&Run, CommandError> {
        let digest: [u8; 32] = Sha256::digest(credential).into();
        self.run
            .as_ref()
            .filter(|run| {
                !run.revoked
                    && run.launch.instance == instance
                    && bool::from(run.launch.credential.0.ct_eq(&digest))
            })
            .ok_or(CommandError::InvalidReportCredential)
    }

    /// Apply an authorized command. A revoked run stays bound until a later pass
    /// observes it quiescent, even when the new phase is terminal.
    ///
    /// # Errors
    /// Returns an error if the command's head evidence is missing or no longer
    /// matches, a move fails the merge gate, or an answer is invalid.
    pub fn command(
        &mut self,
        command: Command,
        authority: &Authority,
        observation: &Observation,
    ) -> Result<(), CommandError> {
        match command {
            Command::Move(phase) => {
                self.check_move(phase, observation)?;
                self.move_to(phase);
            }
            Command::MoveWork { instruction } => self.move_work(&instruction)?,
            Command::Complete {
                version,
                artifact,
                reason,
            } => {
                let report = self
                    .report_state
                    .as_mut()
                    .ok_or(CommandError::ReportOwnerAction)?;
                let acceptance = ReportAcceptance {
                    version,
                    artifact,
                    owner: Acceptance {
                        authority: authority.clone(),
                        reason: reason.trim().to_owned(),
                    },
                };
                if self.phase == Phase::Done && report.acceptance.as_ref() == Some(&acceptance) {
                    return Ok(());
                }
                if self.phase != Phase::ReportReady || self.run.is_some() || self.hold.is_some() {
                    return Err(CommandError::ReportOwnerAction);
                }
                if acceptance.owner.reason.is_empty()
                    || report
                        .delivery
                        .as_ref()
                        .is_none_or(|delivery| delivery.artifact != acceptance.artifact)
                {
                    return Err(CommandError::ReportAcceptanceMismatch);
                }
                if !report.receipts.iter().any(|receipt| {
                    matches!(&receipt.report, Report::ReportReady(delivery)
                        if report.delivery.as_ref() == Some(delivery))
                }) {
                    return Err(CommandError::ReportAcceptanceMismatch);
                }
                report.acceptance = Some(acceptance);
                self.move_to(Phase::Done);
            }
            Command::Cancel => self.move_to(Phase::Cancelled),
            Command::Answer(answer) => self.answer(answer, authority, observation)?,
            Command::Amend(text) => {
                if let Some(pr) = &self.pr {
                    forge_at_head(observation, Some(&pr.head))?;
                }
                self.amend(text)?;
            }
            Command::Hold(reason) => {
                self.hold = Some(Hold {
                    reason,
                    by: Some(match authority {
                        Authority::Operator { .. } => HoldBy::Operator,
                        Authority::Planner { .. } => HoldBy::Planner,
                    }),
                    actor: None,
                    since_ms: None,
                });
            }
            Command::Release => {
                if self.hold.is_some() {
                    self.hold = None;
                } else {
                    self.check_merge_hold_owner(authority)?;
                    self.merge_hold = None;
                }
            }
        }
        Ok(())
    }

    /// Apply the validated merge hold declaration at admission or when it changes.
    ///
    /// # Errors
    /// Returns an error if a change would override another owner's hold or
    /// if the task has already reached merging.
    pub fn set_brief_merge_hold(
        &mut self,
        reason: Option<&str>,
        authority: &Authority,
        since_ms: u64,
    ) -> Result<(), CommandError> {
        if matches!(self.phase, Phase::Merging | Phase::Closing) || self.phase.is_terminal() {
            return Err(CommandError::MergeHoldChangeTooLate);
        }
        self.check_merge_hold_owner(authority)?;
        let (by, actor) = match authority {
            Authority::Operator { actor } => (HoldBy::Operator, actor),
            Authority::Planner { actor } => (HoldBy::Planner, actor),
        };
        self.merge_hold = reason.map(|reason| Hold {
            reason: reason.into(),
            by: Some(by),
            actor: Some(actor.clone()),
            since_ms: Some(since_ms),
        });
        Ok(())
    }

    fn check_merge_hold_owner(&self, authority: &Authority) -> Result<(), CommandError> {
        if let Authority::Planner { actor } = authority
            && let Some(hold) = &self.merge_hold
            && (hold.by != Some(HoldBy::Planner) || hold.actor.as_ref() != Some(actor))
        {
            return Err(CommandError::MergeHoldOwner);
        }
        Ok(())
    }

    /// Revoke the current run for the operator's global stop. The task keeps
    /// its phase, attempts and question, and the scheduler settles the run
    /// through the same stop custody as a move.
    pub fn revoke_run(&mut self) {
        if let Some(run) = &mut self.run {
            run.revoked = true;
        }
    }

    /// Whether the next launch would be this task's first.
    #[must_use]
    pub fn first_launch(&self) -> bool {
        matches!(self.phase, Phase::Queued | Phase::Working)
            && self.run.is_none()
            && self.identity.entry == crate::Entry::Brief
            && self.threads.get(Role::Worker).is_none()
            && self.threads.get(Role::Reviewer).is_none()
    }

    /// Apply the same capacity decision to legacy tasks and new admissions.
    pub fn reconcile_capacity(&mut self) -> Action {
        let action = crate::decision::capacity_blocked(self);
        if let Action::Advance(phase) = action {
            self.phase = phase;
        }
        action
    }

    /// A native reservation is durable even if its first send was never attempted.
    #[must_use]
    pub const fn dispatch_started(&self) -> bool {
        self.threads.launch_sequence != 0 || self.run.is_some()
    }

    fn move_work(&mut self, instruction: &str) -> Result<(), CommandError> {
        let instruction = instruction.trim();
        if instruction.is_empty() {
            return Err(CommandError::ReportInstructionRequired);
        }
        if let Some(report) = &mut self.report_state {
            if !matches!(
                self.phase,
                Phase::Working | Phase::ReportReady | Phase::Blocked | Phase::Error
            ) {
                return Err(CommandError::ReportOwnerAction);
            }
            report.delivery = None;
            report.failure = None;
            report.instruction = Some(instruction.to_owned());
            self.move_to(Phase::Working);
        } else {
            self.request_work(instruction.to_owned(), None);
        }
        Ok(())
    }

    fn request_work(&mut self, instruction: String, require_new_head_from: Option<Head>) {
        if self.pr.as_ref().is_some_and(|pr| self.approves(&pr.head)) {
            self.verdict = None;
        }
        self.move_to(Phase::Working);
        self.work_continuation = Some(WorkContinuation {
            instruction,
            require_new_head_from,
        });
    }

    fn move_to(&mut self, phase: Phase) {
        if let Some(run) = &mut self.run {
            run.revoked = true;
        }
        self.phase = phase;
        if phase != Phase::Reviewing {
            self.threads.same_head_revision_summary = None;
        }
        self.attempts = 0;
        self.question = None;
        self.work_continuation = None;
        self.threads.missing_report_from = None;
    }

    fn check_move(&self, phase: Phase, observation: &Observation) -> Result<(), CommandError> {
        if matches!(phase, Phase::ReportReady | Phase::Blocked | Phase::Error)
            || (self.report_state.is_some()
                && !(phase == Phase::Cancelled
                    || (self.phase == Phase::Queued && phase == Phase::Working)))
        {
            return Err(CommandError::ReportOwnerAction);
        }
        if !matches!(phase, Phase::Merging | Phase::Closing | Phase::Done) {
            return Ok(());
        }
        let forge = forge_at_head(observation, self.pr.as_ref().map(|pr| &pr.head))?;
        if phase != Phase::Merging && !matches!(forge, Forge::Merged { .. }) {
            return Err(CommandError::MergedHeadRequired);
        }
        if !forge.pr().is_some_and(|pr| self.approves(&pr.head)) {
            return Err(CommandError::MergeAuthorityRequired);
        }
        Ok(())
    }

    fn amend(&mut self, text: String) -> Result<(), CommandError> {
        let previous = BriefPolicy::parse(&self.brief.text).ok();
        let next = BriefPolicy::parse(&text).ok();
        let delivery = |policy: Option<&BriefPolicy>| {
            policy
                .map(|policy| (policy.report_only, policy.report_lane.clone()))
                .unwrap_or_default()
        };
        if delivery(previous.as_ref()) != delivery(next.as_ref())
            || (self.report_state.is_some()
                && (next.is_none()
                    || previous.as_ref().map(BriefPolicy::lanes)
                        != next.as_ref().map(BriefPolicy::lanes)))
        {
            return Err(CommandError::ReportPolicyChanged);
        }
        let priority = |policy: Option<&BriefPolicy>| policy.and_then(|policy| policy.priority);
        if priority(previous.as_ref()) != priority(next.as_ref()) {
            return Err(CommandError::QueuePriorityChanged);
        }
        let version = self
            .brief
            .version
            .checked_add(1)
            .ok_or(CommandError::BriefVersionsExhausted)?;
        let complexity = |policy: Option<&BriefPolicy>| {
            policy
                .and_then(|policy| policy.complexity)
                .unwrap_or_default()
        };
        let before = complexity(previous.as_ref());
        let after = complexity(next.as_ref());
        if before != after {
            self.threads.complexity_raised_at = NonZeroU64::new(version).filter(|_| after > before);
            // Older rows lack the complexity under which the worker was selected.
            // Seed that baseline before changing the brief.
            if let Some(bound) = &mut self.threads.worker_profile {
                bound.complexity.get_or_insert(before);
            }
            if let Some(run) = &mut self.run
                && run.launch.role == Role::Worker
                && let Some(bound) = &mut run.launch.profile
            {
                bound.complexity.get_or_insert(before);
            }
        }
        self.brief = Brief::new(text, version);
        Ok(())
    }

    fn answer(
        &mut self,
        answer: Answer,
        authority: &Authority,
        observation: &Observation,
    ) -> Result<(), CommandError> {
        if observation.supersedes_question(self) {
            return Err(CommandError::AnswerDoesNotMatch);
        }
        let question = self
            .question
            .as_ref()
            .ok_or(CommandError::AnswerDoesNotMatch)?;
        if question.operator_decline.is_some() {
            return Err(CommandError::AnswerDoesNotMatch);
        }
        let check_question_head = || -> Result<(), CommandError> {
            if let Some(head) = &question.head {
                forge_at_head(observation, Some(head))?;
            }
            Ok(())
        };
        match (&question.question, answer) {
            (Question::Repair(Repair::MergeBlocked), Answer::Work(instruction)) => {
                check_question_head()?;
                self.move_work(&instruction)?;
            }
            (Question::Work { .. } | Question::Repair(_), Answer::Work(answer)) => {
                check_question_head()?;
                self.amend(format!(
                    "{}\n\nPlanner guidance\n\n{answer}",
                    self.brief.text
                ))?;
            }
            (Question::Allowance { .. }, Answer::Extend)
                if matches!(authority, Authority::Planner { .. }) => {}
            (Question::Retry { .. }, Answer::Retry) => {
                check_question_head()?;
                self.attempts = 0;
            }
            (Question::Accept { head: asked }, Answer::Accept { head, reason })
                if head == *asked =>
            {
                if !authority.can_accept(self.identity.entry) {
                    return Err(CommandError::OperatorRequired);
                }
                if !matches!(
                    forge_at_head(observation, Some(&head))?,
                    Forge::Merged { .. }
                ) {
                    return Err(CommandError::MergedHeadRequired);
                }
                if reason.trim().is_empty() {
                    return Err(CommandError::AcceptanceReasonRequired);
                }
                self.verdict = Some(Verdict::Accepted {
                    head,
                    acceptance: Acceptance {
                        authority: authority.clone(),
                        reason,
                    },
                });
            }
            _ => {
                return Err(CommandError::ExpectedAnswer(
                    question.question.answer_form(),
                ));
            }
        }
        self.question = None;
        Ok(())
    }
}

fn launch_credential(seed: &[u8; 32], instance: &str) -> CallbackCredential {
    CallbackCredential(
        Sha256::new()
            .chain_update(seed)
            .chain_update(instance.as_bytes())
            .finalize()
            .into(),
    )
}

fn forge_at_head<'a>(
    observation: &'a Observation,
    head: Option<&Head>,
) -> Result<&'a Forge, CommandError> {
    let Observed::Known(forge) = &observation.forge else {
        return Err(CommandError::HeadUnverified);
    };
    if let Some(head) = head
        && !forge.pr().is_some_and(|pr| pr.head == *head)
    {
        return Err(CommandError::HeadChanged);
    }
    Ok(forge)
}
