use crate::model::{
    Head, Phase, PullRequest, Question, Repair, Report, Review, Role, Task, Verdict,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Observed<T> {
    Unknown,
    Known(T),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    pub host: Observed<Host>,
    pub forge: Observed<Forge>,
    pub workspace: Observed<Workspace>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    ProviderLimited {
        instance: String,
        cause: String,
    },
    Retained {
        thread: String,
        state: RetainedThread,
    },
    Current {
        instance: String,
        state: RunState,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetainedThread {
    /// A complete observation of the exact thread shows no active or pending turn.
    Idle,
    /// This retained role can receive a pinned continuation through the native queue.
    Queueable,
    Busy,
    /// Host-authoritative absence or a tombstone for the exact thread ID.
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    /// The exact request can be sent or replayed under the same native receipt
    /// identity. For a revoked run this means no send was ever recorded.
    ReadyToSend,
    Starting,
    Running,
    IdleWithoutTerminalRun,
    Permission,
    Input,
    /// The exact native turn associated with this reservation is terminal.
    Ended,
    /// The exact native turn ended on a provider usage limit.
    UsageLimited,
    /// The frozen parent ended and the exact delegated child is absent.
    ParentEnded,
    /// A host input-size check rejected the frozen assignment before execution.
    AssignmentRejected,
    /// A previously confirmed run or thread disappeared on an authoritative read.
    Gone,
    /// A checked receipt or a proven pre-send failure confirms that the exact
    /// reservation failed. Timeouts, deferrals and ambiguous errors are unknown.
    Rejected,
}

impl RunState {
    pub(crate) const fn quiescent(self) -> bool {
        matches!(
            self,
            Self::ReadyToSend
                | Self::Ended
                | Self::UsageLimited
                | Self::ParentEnded
                | Self::AssignmentRejected
                | Self::Gone
                | Self::Rejected
        )
    }

    pub(crate) const fn ended(self) -> bool {
        matches!(self, Self::Ended | Self::UsageLimited)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Forge {
    Absent,
    Open { pr: PullRequest, checks: CheckState },
    Closed(PullRequest),
    Merged { pr: PullRequest, commit: Head },
}

impl Forge {
    pub(crate) const fn pr(&self) -> Option<&PullRequest> {
        match self {
            Self::Absent => None,
            Self::Open { pr, .. } | Self::Closed(pr) | Self::Merged { pr, .. } => Some(pr),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckState {
    Unknown,
    Pending,
    Blocked,
    Conflict,
    BaseMoved,
    FailedRequired(Vec<String>),
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Workspace {
    /// The expected task checkout is definitively absent.
    Absent,
    Dirty,
    /// Fresh Git evidence from the owned checkout binds its current head and
    /// confirms no staged, modified, conflicted or non-ignored untracked files. The adapter
    /// rechecks this immediately before any unforced removal.
    Clean(Head),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    Create,
    Continue { thread: String },
    SendPrepared,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseWorkspace {
    AlreadyAbsent,
    Retain,
    RemoveClean { head: Head },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitReason {
    Hold,
    MergeHold,
    Question,
    OperatorDeclined,
    HostUnknown,
    HostObservationBlocked,
    Starting,
    Running,
    IdleWithoutTerminalRun,
    Permission,
    UsagePermission,
    Input,
    RetainedThreadBusy,
    Stopping,
    ForgeUnknown,
    ReviewPublicationBlocked,
    ExternalMergeBlocked,
    WorkspaceUnknown,
    WorkspaceBlocked,
    ChecksPending,
    Prerequisite,
    Capacity,
    AssignmentTooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Launch {
        role: Role,
        via: Launch,
    },
    Wait(WaitReason),
    Advance(Phase),
    Revoke,
    Merge {
        head: Head,
    },
    Close {
        commit: Head,
        workspace: CloseWorkspace,
    },
    Relaunch(Role),
    RemindReport,
    Ask(Question),
    Nothing,
}

enum Signal {
    Finished,
    Wait(WaitReason),
    Stopped(Phase),
    ReservationDiscarded(Phase),
    Refresh(Phase),
    Admitted,
    Start(Role, Launch),
    Failed(Role),
    RemindReport,
    WorkerReported,
    ReportSettled(Phase),
    ReviewerReported(Review),
    NeedsReview,
    MergeConfirmed,
    ReadyToMerge(Head),
    ReadyToClose(Head, CloseWorkspace),
    Question(Question),
}

/// Choose an action from current facts. Unknown observations grant no authority.
#[must_use]
pub fn decide(task: &Task, observation: &Observation) -> Action {
    match signal(task, observation) {
        Signal::Finished => Action::Nothing,
        Signal::Wait(reason) => Action::Wait(reason),
        Signal::ReservationDiscarded(_)
            if task
                .run()
                .is_some_and(|run| run.last_send_at_ms().is_some()) =>
        {
            Action::Revoke
        }
        Signal::Stopped(phase) | Signal::Refresh(phase) | Signal::ReservationDiscarded(phase) => {
            Action::Advance(phase)
        }
        Signal::Admitted | Signal::ReviewerReported(Review::Changes) => {
            Action::Advance(Phase::Working)
        }
        Signal::ReportSettled(phase) => Action::Advance(phase),
        Signal::WorkerReported | Signal::NeedsReview => Action::Advance(Phase::Reviewing),
        Signal::ReviewerReported(Review::Approve) => Action::Advance(Phase::Merging),
        Signal::MergeConfirmed => Action::Advance(Phase::Closing),
        Signal::Start(role, via) => Action::Launch { role, via },
        Signal::Failed(role) if task.attempts < 2 => Action::Relaunch(role),
        Signal::Failed(_) if task.report_task().is_some() => Action::Advance(Phase::Blocked),
        Signal::Failed(role) => Action::Ask(Question::Retry { role }),
        Signal::RemindReport => Action::RemindReport,
        Signal::ReadyToMerge(head) => Action::Merge { head },
        Signal::ReadyToClose(commit, workspace) => Action::Close { commit, workspace },
        Signal::Question(question) => Action::Ask(question),
    }
}

pub(crate) fn capacity_blocked(task: &Task) -> Action {
    if task.phase == Phase::Working && task.first_launch() {
        Action::Advance(Phase::Queued)
    } else {
        Action::Wait(WaitReason::Capacity)
    }
}

fn signal(task: &Task, observation: &Observation) -> Signal {
    if let Some(run) = task.run().filter(|run| run.revoked()) {
        return match observation.current(&run.launch.instance) {
            Some(RunState::Rejected) if run.rejected_awaiting_archive() => {
                Signal::Stopped(task.phase)
            }
            _ if run.rejected_awaiting_archive() => Signal::Wait(WaitReason::Stopping),
            Some(state) if state.quiescent() => Signal::Stopped(task.phase),
            _ => Signal::Wait(WaitReason::Stopping),
        };
    }
    if task.phase.is_terminal() {
        return Signal::Finished;
    }
    if observation.supersedes_question(task) || observation.resolves_repair(task) {
        return Signal::Refresh(task.phase);
    }
    if task.hold.is_some() {
        return Signal::Wait(WaitReason::Hold);
    }
    if task.question.is_some() {
        return Signal::Wait(WaitReason::Question);
    }
    if let Some(run) = task.run() {
        let role = run.launch.role;
        if let Some(report) = run.report() {
            return settled(task, observation, role, Ok(report));
        }
        if role == Role::Reviewer
            && run.last_send_at_ms().is_none()
            && observation.workspace == Observed::Known(Workspace::Absent)
        {
            return Signal::ReservationDiscarded(Phase::Reviewing);
        }
        return match observation.current(&run.launch.instance) {
            Some(RunState::ReadyToSend) => {
                prepared(observation, role, run.launch.review_head.as_ref())
            }
            Some(RunState::Starting) => Signal::Wait(WaitReason::Starting),
            Some(RunState::Running) => Signal::Wait(WaitReason::Running),
            Some(RunState::IdleWithoutTerminalRun) => {
                Signal::Wait(WaitReason::IdleWithoutTerminalRun)
            }
            Some(RunState::Permission) => Signal::Wait(WaitReason::Permission),
            Some(RunState::Input) => Signal::Wait(WaitReason::Input),
            Some(RunState::UsageLimited) => Signal::Failed(role),
            Some(RunState::ParentEnded | RunState::AssignmentRejected) => {
                Signal::Stopped(task.phase)
            }
            None => Signal::Wait(WaitReason::HostUnknown),
            Some(state @ (RunState::Ended | RunState::Gone | RunState::Rejected)) => {
                settled(task, observation, role, Err(state))
            }
        };
    }
    if task.report_task().is_some() {
        return match task.phase {
            Phase::Queued => Signal::Admitted,
            Phase::Working if observation.workspace == Observed::Unknown => {
                Signal::Wait(WaitReason::WorkspaceUnknown)
            }
            Phase::Working => launch(task, observation, Role::Worker),
            _ => Signal::Finished,
        };
    }
    unbound(task, observation)
}

fn prepared(observation: &Observation, role: Role, review_head: Option<&Head>) -> Signal {
    let Some(head) = review_head else {
        return Signal::Start(role, Launch::SendPrepared);
    };
    match (&observation.forge, &observation.workspace) {
        (Observed::Unknown, _) => Signal::Wait(WaitReason::ForgeUnknown),
        (Observed::Known(Forge::Open { pr, .. }), workspace) if pr.head == *head => match workspace
        {
            Observed::Unknown => Signal::Wait(WaitReason::WorkspaceUnknown),
            Observed::Known(Workspace::Clean(observed)) if observed == head => {
                Signal::Start(role, Launch::SendPrepared)
            }
            Observed::Known(_) => Signal::ReservationDiscarded(Phase::Reviewing),
        },
        (Observed::Known(_), _) => Signal::ReservationDiscarded(Phase::Reviewing),
    }
}

fn settled(
    task: &Task,
    observation: &Observation,
    role: Role,
    disposition: Result<&Report, RunState>,
) -> Signal {
    let report = disposition.ok();
    let missing = || {
        disposition.err().map_or(Signal::Failed(role), |state| {
            missing_report(task, role, state)
        })
    };
    if task.report_task().is_some() {
        return match report {
            Some(Report::ReportReady(_)) => Signal::ReportSettled(Phase::ReportReady),
            Some(Report::Blocked(_)) => Signal::ReportSettled(Phase::Blocked),
            Some(Report::Error(_)) => Signal::ReportSettled(Phase::Error),
            None => missing(),
            _ => Signal::Failed(role),
        };
    }
    if matches!(observation.forge, Observed::Unknown)
        && (role == Role::Reviewer || task.pr.is_some() || matches!(report, Some(Report::Work(_))))
    {
        return Signal::Wait(WaitReason::ForgeUnknown);
    }
    if let Observed::Known(Forge::Merged { pr, .. }) = &observation.forge {
        let reported_approval = matches!(report, Some(Report::Review { head, decision: Review::Approve, .. }) if *head == pr.head);
        return merged_signal(task, pr, reported_approval);
    }
    if (role == Role::Reviewer || disposition.is_err_and(|state| state != RunState::Ended))
        && observation
            .pr()
            .is_some_and(|pr| Some(pr) != task.pr.as_ref())
    {
        return Signal::Refresh(task.phase);
    }
    if role == Role::Reviewer
        && matches!(disposition, Err(RunState::Ended))
        && !matches!(&observation.forge, Observed::Known(Forge::Open { pr, .. })
            if task.run().and_then(|run| run.launch.review_head.as_ref()) == Some(&pr.head))
    {
        return Signal::Refresh(task.phase);
    }
    match report {
        None => missing(),
        Some(Report::ReportReady(_) | Report::Blocked(_) | Report::Error(_)) => {
            Signal::Failed(role)
        }
        Some(Report::Question { prompt, options }) => Signal::Question(Question::Work {
            prompt: prompt.clone(),
            options: options.clone(),
        }),
        Some(Report::Work(reported)) => match &observation.forge {
            Observed::Unknown => Signal::Wait(WaitReason::ForgeUnknown),
            Observed::Known(Forge::Open { pr, .. }) if *pr == reported.pull_request => {
                if task
                    .work_continuation
                    .as_ref()
                    .is_some_and(|work| work.require_new_head_from.as_ref() == Some(&pr.head))
                    || matches!(&task.verdict, Some(Verdict::Reviewed { head, decision: Review::Changes, .. }) if *head == pr.head)
                {
                    Signal::Question(Question::Repair(Repair::RevisionHasSameHead))
                } else {
                    Signal::WorkerReported
                }
            }
            Observed::Known(_) => {
                Signal::Question(Question::Repair(Repair::PullRequestUnavailable))
            }
        },
        Some(Report::Review { head, decision, .. }) => match &observation.forge {
            Observed::Unknown => Signal::Wait(WaitReason::ForgeUnknown),
            Observed::Known(Forge::Open { pr, .. }) if *head == pr.head => {
                Signal::ReviewerReported(*decision)
            }
            Observed::Known(_) => {
                Signal::Question(Question::Repair(Repair::PullRequestUnavailable))
            }
        },
    }
}

pub(crate) fn missing_report_cause(role: Role, state: RunState) -> String {
    let role = match role {
        Role::Worker => "worker",
        Role::Reviewer => "reviewer",
    };
    let outcome = match state {
        RunState::Gone => "could no longer be found",
        RunState::Rejected => "was rejected by the host",
        RunState::UsageLimited => "hit the provider usage limit",
        _ => "ended",
    };
    format!("The {role}'s report reminder {outcome} without an authenticated report.")
}

fn missing_report(task: &Task, role: Role, state: RunState) -> Signal {
    if task
        .run()
        .and_then(crate::model::Run::report_reminder_for)
        .is_some()
    {
        if task.report_task().is_some() {
            return Signal::ReportSettled(Phase::Blocked);
        }
        let cause = missing_report_cause(role, state);
        return Signal::Question(Question::Work {
            prompt: format!(
                "{cause} Inspect the retained thread. Answer with instructions to retry, or cancel the task."
            ),
            options: Vec::new(),
        });
    }
    if state == RunState::Ended {
        return Signal::RemindReport;
    }
    Signal::Failed(role)
}

fn unbound(task: &Task, observation: &Observation) -> Signal {
    if matches!(
        task.phase,
        Phase::Queued | Phase::Working | Phase::Reviewing | Phase::Merging | Phase::Closing
    ) && let Observed::Known(Forge::Merged { pr, commit }) = &observation.forge
    {
        if task.phase != Phase::Closing || !task.approves(&pr.head) {
            return merged_signal(task, pr, false);
        }
        return match &observation.workspace {
            Observed::Unknown => Signal::Wait(WaitReason::WorkspaceUnknown),
            Observed::Known(Workspace::Absent) => {
                Signal::ReadyToClose(commit.clone(), CloseWorkspace::AlreadyAbsent)
            }
            Observed::Known(Workspace::Clean(head)) if *head == pr.head => Signal::ReadyToClose(
                commit.clone(),
                CloseWorkspace::RemoveClean { head: head.clone() },
            ),
            Observed::Known(Workspace::Dirty | Workspace::Clean(_)) => {
                Signal::ReadyToClose(commit.clone(), CloseWorkspace::Retain)
            }
        };
    }
    match task.phase {
        Phase::Queued => Signal::Admitted,
        Phase::Working => match (&task.pr, &observation.forge, &observation.workspace) {
            (Some(_), Observed::Unknown, _) => Signal::Wait(WaitReason::ForgeUnknown),
            (old, Observed::Known(Forge::Open { pr, .. }), _) if old.as_ref() != Some(pr) => {
                Signal::Refresh(Phase::Working)
            }
            (_, _, Observed::Unknown) => Signal::Wait(WaitReason::WorkspaceUnknown),
            (_, _, Observed::Known(_)) => launch(task, observation, Role::Worker),
        },
        Phase::Reviewing => match (&observation.forge, &observation.workspace) {
            (Observed::Unknown, _) => Signal::Wait(WaitReason::ForgeUnknown),
            (Observed::Known(Forge::Open { pr, .. }), _) if Some(pr) != task.pr.as_ref() => {
                Signal::Refresh(Phase::Reviewing)
            }
            (
                Observed::Known(Forge::Open { .. }),
                Observed::Unknown | Observed::Known(Workspace::Absent),
            ) => Signal::Wait(WaitReason::WorkspaceUnknown),
            (Observed::Known(Forge::Open { pr, .. }), Observed::Known(Workspace::Clean(head)))
                if *head == pr.head =>
            {
                launch(task, observation, Role::Reviewer)
            }
            (
                Observed::Known(Forge::Open { .. }),
                Observed::Known(Workspace::Clean(_) | Workspace::Dirty),
            ) => Signal::Question(Question::Repair(Repair::WorkspaceHeadMismatch)),
            (Observed::Known(_), _) => {
                Signal::Question(Question::Repair(Repair::PullRequestUnavailable))
            }
        },
        Phase::Merging => merge_signal(task, observation),
        Phase::Closing => match &observation.forge {
            Observed::Unknown => Signal::Wait(WaitReason::ForgeUnknown),
            Observed::Known(_) => Signal::Question(Question::Repair(Repair::MergeUnconfirmed)),
        },
        Phase::ReportReady | Phase::Blocked | Phase::Error | Phase::Done | Phase::Cancelled => {
            Signal::Finished
        }
    }
}

fn merge_signal(task: &Task, observation: &Observation) -> Signal {
    if task.verdict.is_none()
        && task.pr.as_ref().is_some_and(|cached| {
            observation
                .pr()
                .is_none_or(|current| current.head == cached.head)
        })
    {
        return Signal::Wait(WaitReason::ForgeUnknown);
    }
    match &observation.forge {
        Observed::Known(Forge::Open { pr, .. }) if !task.approves(&pr.head) => Signal::NeedsReview,
        Observed::Unknown
        | Observed::Known(Forge::Open {
            checks: CheckState::Unknown,
            ..
        }) => Signal::Wait(WaitReason::ForgeUnknown),
        Observed::Known(Forge::Open {
            checks: CheckState::Pending,
            ..
        }) => Signal::Wait(WaitReason::ChecksPending),
        Observed::Known(Forge::Open {
            checks: CheckState::Ready,
            ..
        }) if task.merge_hold().is_some() => Signal::Wait(WaitReason::MergeHold),
        Observed::Known(Forge::Open {
            pr,
            checks: CheckState::Ready,
        }) => Signal::ReadyToMerge(pr.head.clone()),
        Observed::Known(Forge::Open { .. }) if observation.recoverable_merge(task).is_some() => {
            Signal::Refresh(Phase::Working)
        }
        Observed::Known(Forge::Open { .. }) => {
            Signal::Question(Question::Repair(Repair::MergeBlocked))
        }
        Observed::Known(_) => Signal::Question(Question::Repair(Repair::PullRequestUnavailable)),
    }
}

impl Observation {
    fn recoverable_merge(&self, task: &Task) -> Option<(&Head, &CheckState)> {
        match &self.forge {
            Observed::Known(Forge::Open { pr, checks })
                if matches!(
                    checks,
                    CheckState::Conflict | CheckState::BaseMoved | CheckState::FailedRequired(_)
                ) && task.phase == Phase::Merging
                    && task.threads.get(Role::Worker).is_some()
                    && task.approves(&pr.head) =>
            {
                Some((&pr.head, checks))
            }
            _ => None,
        }
    }

    pub(crate) fn merge_recovery(&self, task: &Task) -> Option<(&Head, String)> {
        let (head, checks) = self.recoverable_merge(task)?;
        let base = &task.identity.base;
        let instruction = match checks {
            CheckState::Conflict => format!(
                "GitHub confirms a merge conflict at {head}. Fetch origin/{base}, rebase the task branch onto it, resolve the conflicts, run the relevant checks, and push the same PR branch with --force-with-lease."
            ),
            CheckState::BaseMoved => format!(
                "The base moved at reviewed head {head}. Fetch origin/{base}, rebase the task branch onto it, run the relevant checks, and push the same PR branch with --force-with-lease."
            ),
            CheckState::FailedRequired(names) => format!(
                "GitHub required checks failed at {head}: {names:?}. Inspect those failures, fix the task branch, run the relevant checks, and push the new head to the same PR branch."
            ),
            _ => return None,
        };
        Some((
            head,
            format!("{instruction} Report the published head for fresh review."),
        ))
    }
}

fn merged_signal(task: &Task, pr: &PullRequest, reported_approval: bool) -> Signal {
    if task.approves(&pr.head) || reported_approval {
        Signal::MergeConfirmed
    } else {
        Signal::Question(Question::Accept {
            head: pr.head.clone(),
        })
    }
}

fn launch(task: &Task, observation: &Observation, role: Role) -> Signal {
    let Some(retained) = task.threads.get(role) else {
        return Signal::Start(role, Launch::Create);
    };
    match &observation.host {
        Observed::Known(Host::Retained { thread, state }) if thread == retained => match state {
            RetainedThread::Idle | RetainedThread::Queueable => Signal::Start(
                role,
                Launch::Continue {
                    thread: thread.clone(),
                },
            ),
            RetainedThread::Gone => Signal::Start(role, Launch::Create),
            RetainedThread::Busy => Signal::Wait(WaitReason::RetainedThreadBusy),
        },
        _ => Signal::Wait(WaitReason::HostUnknown),
    }
}

impl Observation {
    pub(crate) fn supersedes_question(&self, task: &Task) -> bool {
        matches!((&task.question, self.pr()), (Some(question), Some(pr)) if question.outdated_at(&pr.head))
    }

    // Re-evaluate the condition that asked the question. Missing evidence
    // cannot resolve it, and resolving it does not authorize any native effect.
    pub(crate) fn resolves_repair(&self, task: &Task) -> bool {
        let (Some(question), Observed::Known(forge)) = (&task.question, &self.forge) else {
            return false;
        };
        if matches!(question.question, Question::Allowance { .. })
            && matches!(forge, Forge::Merged { .. })
        {
            return true;
        }
        let Question::Repair(repair) = question.question else {
            return false;
        };
        if task.run.is_some() {
            return false;
        }
        match repair {
            Repair::PullRequestUnavailable => {
                matches!(forge, Forge::Open { .. } | Forge::Merged { .. })
            }
            Repair::WorkspaceHeadMismatch => match forge {
                Forge::Open { pr, .. } => match &self.workspace {
                    Observed::Known(Workspace::Clean(head)) => *head == pr.head,
                    Observed::Known(Workspace::Absent) => true,
                    Observed::Known(Workspace::Dirty) | Observed::Unknown => false,
                },
                _ => true,
            },
            Repair::RevisionHasSameHead => {
                forge.pr().is_some_and(|pr| question.outdated_at(&pr.head))
            }
            Repair::MergeBlocked => {
                self.recoverable_merge(task).is_some()
                    || !matches!(
                        forge,
                        Forge::Open {
                            checks: CheckState::Blocked
                                | CheckState::Conflict
                                | CheckState::BaseMoved
                                | CheckState::FailedRequired(_)
                                | CheckState::Unknown,
                            ..
                        }
                    )
            }
            Repair::MergeUnconfirmed => matches!(forge, Forge::Merged { .. }),
        }
    }

    pub(crate) fn current(&self, expected: &str) -> Option<RunState> {
        match &self.host {
            Observed::Known(Host::ProviderLimited { instance, .. }) if instance == expected => {
                Some(RunState::UsageLimited)
            }
            Observed::Known(Host::Current { instance, state }) if instance == expected => {
                Some(*state)
            }
            _ => None,
        }
    }

    pub(crate) fn pr(&self) -> Option<&PullRequest> {
        match &self.forge {
            Observed::Known(forge) => forge.pr(),
            Observed::Unknown => None,
        }
    }
}
