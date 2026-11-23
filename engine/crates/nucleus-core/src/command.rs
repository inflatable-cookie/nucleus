use std::fmt;

use subtle::ConstantTimeEq;

use crate::decision::{Action, CloseWorkspace, Forge, Launch, Observation, Observed, decide};
use crate::model::{
    Acceptance, Authority, Brief, CredentialDigest, Entry, Head, Hold, Phase, PreparedLaunch,
    Question, Report, Role, Run, Task, Verdict,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    Move(Phase),
    Answer(Answer),
    Cancel,
    Amend(String),
    Hold(String),
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Work(String),
    Retry,
    Accept { head: Head, reason: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandError {
    MergeAuthorityRequired,
    MergedHeadRequired,
    AnswerDoesNotMatch,
    OperatorRequired,
    BriefVersionsExhausted,
    LaunchNoLongerApplies,
    InvalidReportCredential,
    ReportDoesNotMatch,
    ReportAlreadyReceived,
}

impl fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::MergeAuthorityRequired => "the current PR head needs approval or acceptance",
            Self::MergedHeadRequired => "the current PR head needs a confirmed merge",
            Self::AnswerDoesNotMatch => "the answer does not match the current question",
            Self::OperatorRequired => "the operator must accept the head of a review entry",
            Self::BriefVersionsExhausted => "the brief version cannot be incremented",
            Self::LaunchNoLongerApplies => {
                "the launch does not match the current task and observation"
            }
            Self::InvalidReportCredential => {
                "the report does not authenticate against the current run"
            }
            Self::ReportDoesNotMatch => "the report does not match the current role or review head",
            Self::ReportAlreadyReceived => "the run already sent a different report",
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
            Action::Relaunch(_) => {
                self.run = None;
                self.attempts += 1;
            }
            Action::Ask(question) => {
                self.run = None;
                if matches!(question, Question::Retry { .. }) {
                    self.attempts = 3;
                }
                if matches!(question, Question::Accept { .. }) {
                    if let Some(pr) = observation.pr() {
                        self.observe_pr(pr);
                    }
                }
                self.question = Some(question.clone());
            }
            Action::Launch { .. }
            | Action::Wait(_)
            | Action::Merge { .. }
            | Action::Close { .. }
            | Action::Nothing => {}
        }
        action
    }

    fn advance(&mut self, phase: Phase, observation: &Observation) {
        let run = self.run.take();
        if run.as_ref().is_some_and(|run| run.revoked) {
            return;
        }
        if let Some(pr) = observation.pr() {
            self.observe_pr(pr);
        }
        if let Some(Report::Review {
            head,
            decision,
            summary,
        }) = run.and_then(|run| run.report)
        {
            if self.pr.as_ref().is_some_and(|pr| pr.head == head) {
                self.verdict = Some(Verdict::Reviewed {
                    head,
                    decision,
                    summary,
                });
            }
        }
        if self.phase != phase {
            self.attempts = 0;
            self.phase = phase;
        }
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

    /// Reserve a run before sending it to T3. The service generates a new instance
    /// for each reservation, even when the readable label repeats after a move.
    ///
    /// # Errors
    /// Returns an error when the observation no longer calls for this launch.
    pub fn reserve_launch(
        &mut self,
        observation: &Observation,
        launch: PreparedLaunch,
    ) -> Result<(), CommandError> {
        let valid_review_head = match launch.role {
            Role::Worker => launch.review_head.is_none(),
            Role::Reviewer => launch.review_head.as_ref() == observation.pr().map(|pr| &pr.head),
        };
        let Action::Launch { role, via } = decide(self, observation) else {
            return Err(CommandError::LaunchNoLongerApplies);
        };
        let valid_thread = match via {
            Launch::Create => self.threads.get(role) != Some(launch.thread.as_str()),
            Launch::Continue { thread } => launch.thread == thread,
            Launch::SendPrepared => false,
        };
        if !valid_review_head
            || !valid_thread
            || launch.role != role
            || self.phase.role() != Some(role)
            || self.threads.get(role.other()) == Some(launch.thread.as_str())
        {
            return Err(CommandError::LaunchNoLongerApplies);
        }
        self.threads.set(role, launch.thread.clone());
        self.run = Some(Run {
            launch,
            report: None,
            revoked: false,
        });
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
        credential: &CredentialDigest,
        report: Report,
    ) -> Result<(), CommandError> {
        let run = self
            .run
            .as_mut()
            .filter(|run| {
                !run.revoked
                    && run.launch.instance == instance
                    && bool::from(run.launch.credential.0.ct_eq(&credential.0))
            })
            .ok_or(CommandError::InvalidReportCredential)?;
        match (&report, run.launch.role) {
            (Report::Question { .. }, _) | (Report::Work(_), Role::Worker) => {}
            (Report::Review { head, .. }, Role::Reviewer)
                if Some(head) == run.launch.review_head.as_ref() => {}
            _ => return Err(CommandError::ReportDoesNotMatch),
        }
        match &run.report {
            Some(prior) if prior != &report => Err(CommandError::ReportAlreadyReceived),
            Some(_) => Ok(()),
            None => {
                run.report = Some(report);
                Ok(())
            }
        }
    }

    /// Apply an authorized command. A revoked run stays bound until a later pass
    /// observes it quiescent, even when the new phase is terminal.
    ///
    /// # Errors
    /// Returns an error for a move that fails the merge gate or an answer that
    /// lacks authority or does not match the current question.
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
            Command::Cancel => self.move_to(Phase::Cancelled),
            Command::Answer(answer) => self.answer(answer, authority, observation)?,
            Command::Amend(text) => self.amend(text)?,
            Command::Hold(reason) => self.hold = Some(Hold { reason }),
            Command::Release => self.hold = None,
        }
        Ok(())
    }

    fn move_to(&mut self, phase: Phase) {
        if let Some(run) = &mut self.run {
            run.revoked = true;
        }
        self.phase = phase;
        self.attempts = 0;
        self.question = None;
    }

    fn check_move(&self, phase: Phase, observation: &Observation) -> Result<(), CommandError> {
        match phase {
            Phase::Merging if !observation.pr().is_some_and(|pr| self.approves(&pr.head)) => {
                Err(CommandError::MergeAuthorityRequired)
            }
            Phase::Closing | Phase::Done => match &observation.forge {
                Observed::Known(Forge::Merged { pr, .. }) if self.approves(&pr.head) => Ok(()),
                Observed::Known(Forge::Merged { .. }) => Err(CommandError::MergeAuthorityRequired),
                _ => Err(CommandError::MergedHeadRequired),
            },
            _ => Ok(()),
        }
    }

    fn amend(&mut self, text: String) -> Result<(), CommandError> {
        let version = self
            .brief
            .version
            .checked_add(1)
            .ok_or(CommandError::BriefVersionsExhausted)?;
        self.brief = Brief::new(text, version);
        Ok(())
    }

    fn answer(
        &mut self,
        answer: Answer,
        authority: &Authority,
        observation: &Observation,
    ) -> Result<(), CommandError> {
        match (&self.question, answer) {
            (Some(Question::Work { .. } | Question::Repair(_)), Answer::Work(answer)) => {
                self.amend(format!(
                    "{}\n\nPlanner guidance\n\n{answer}",
                    self.brief.text
                ))?;
            }
            (Some(Question::Retry { .. }), Answer::Retry) => self.attempts = 0,
            (Some(Question::Accept { head: asked }), Answer::Accept { head, reason })
                if head == *asked =>
            {
                let Observed::Known(Forge::Merged { pr, .. }) = &observation.forge else {
                    return Err(CommandError::MergedHeadRequired);
                };
                if head != pr.head {
                    return Err(CommandError::AnswerDoesNotMatch);
                }
                if self.identity.entry == Entry::ReviewEntry
                    && matches!(authority, Authority::Planner { .. })
                {
                    return Err(CommandError::OperatorRequired);
                }
                self.verdict = Some(Verdict::Accepted {
                    head,
                    acceptance: Acceptance {
                        authority: authority.clone(),
                        reason,
                    },
                });
            }
            _ => return Err(CommandError::AnswerDoesNotMatch),
        }
        self.question = None;
        Ok(())
    }
}
