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
    Busy,
    /// Host-authoritative absence or a tombstone for the exact thread ID.
    Gone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    /// The native receipt and exact thread/message lookup allow the same request
    /// to be sent. An earlier possible write cannot still land.
    ReadyToSend,
    Starting,
    Running,
    IdleWithoutTerminalRun,
    Permission,
    Input,
    /// The exact native turn associated with this reservation is terminal.
    Ended,
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
            Self::ReadyToSend | Self::Ended | Self::Gone | Self::Rejected
        )
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckState {
    Unknown,
    Pending,
    Blocked,
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Workspace {
    /// The expected task checkout is definitively absent.
    Absent,
    Dirty,
    /// Fresh Git evidence from the owned checkout binds its current head and
    /// confirms no staged, modified, conflicted or untracked files. The adapter
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReason {
    Hold,
    Question,
    HostUnknown,
    Starting,
    Running,
    IdleWithoutTerminalRun,
    Permission,
    Input,
    RetainedThreadBusy,
    Stopping,
    ForgeUnknown,
    WorkspaceUnknown,
    ChecksPending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    Launch {
        role: Role,
        via: Launch,
    },
    Wait(WaitReason),
    Advance(Phase),
    Merge {
        head: Head,
    },
    Close {
        commit: Head,
        workspace: CloseWorkspace,
    },
    Relaunch(Role),
    Ask(Question),
    Nothing,
}

enum Signal {
    Finished,
    Wait(WaitReason),
    Stopped(Phase),
    ReservationDiscarded(Phase),
    HeadChanged(Phase),
    Admitted,
    Start(Role, Launch),
    Failed(Role),
    WorkerReported,
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
        Signal::Stopped(phase)
        | Signal::HeadChanged(phase)
        | Signal::ReservationDiscarded(phase) => Action::Advance(phase),
        Signal::Admitted | Signal::ReviewerReported(Review::Changes) => {
            Action::Advance(Phase::Working)
        }
        Signal::WorkerReported | Signal::NeedsReview => Action::Advance(Phase::Reviewing),
        Signal::ReviewerReported(Review::Approve) => Action::Advance(Phase::Merging),
        Signal::MergeConfirmed => Action::Advance(Phase::Closing),
        Signal::Start(role, via) => Action::Launch { role, via },
        Signal::Failed(role) if task.attempts < 2 => Action::Relaunch(role),
        Signal::Failed(role) => Action::Ask(Question::Retry { role }),
        Signal::ReadyToMerge(head) => Action::Merge { head },
        Signal::ReadyToClose(commit, workspace) => Action::Close { commit, workspace },
        Signal::Question(question) => Action::Ask(question),
    }
}

fn signal(task: &Task, observation: &Observation) -> Signal {
    if let Some(run) = task.run().filter(|run| run.revoked()) {
        return match observation.current(&run.launch.instance) {
            Some(state) if state.quiescent() => Signal::Stopped(task.phase),
            _ => Signal::Wait(WaitReason::Stopping),
        };
    }
    if task.phase.is_terminal() {
        return Signal::Finished;
    }
    if observation.supersedes_question(task) {
        return Signal::HeadChanged(task.phase);
    }
    if task.hold.is_some() {
        return Signal::Wait(WaitReason::Hold);
    }
    if task.question.is_some() {
        return Signal::Wait(WaitReason::Question);
    }
    if let Some(run) = task.run() {
        let role = run.launch.role;
        return match observation.current(&run.launch.instance) {
            None => Signal::Wait(WaitReason::HostUnknown),
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
            Some(RunState::Ended) => settled(task, observation, role, run.report.as_ref()),
            Some(RunState::Gone | RunState::Rejected) => settled(task, observation, role, None),
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

fn settled(task: &Task, observation: &Observation, role: Role, report: Option<&Report>) -> Signal {
    if matches!(observation.forge, Observed::Unknown)
        && (role == Role::Reviewer || task.pr.is_some() || matches!(report, Some(Report::Work(_))))
    {
        return Signal::Wait(WaitReason::ForgeUnknown);
    }
    if let Observed::Known(Forge::Merged { pr, .. }) = &observation.forge {
        let reported_approval = matches!(report, Some(Report::Review { head, decision: Review::Approve, .. }) if *head == pr.head);
        return merged_signal(task, pr, reported_approval);
    }
    if (role == Role::Reviewer || (task.pr.is_some() && report.is_none()))
        && observation
            .pr()
            .is_some_and(|pr| Some(pr) != task.pr.as_ref())
    {
        return Signal::HeadChanged(task.phase);
    }
    match report {
        None => Signal::Failed(role),
        Some(Report::Question { prompt, options }) => Signal::Question(Question::Work {
            prompt: prompt.clone(),
            options: options.clone(),
        }),
        Some(Report::Work(reported)) => match &observation.forge {
            Observed::Unknown => Signal::Wait(WaitReason::ForgeUnknown),
            Observed::Known(Forge::Open { pr, .. }) if pr == reported => {
                if matches!(&task.verdict, Some(Verdict::Reviewed { head, decision: Review::Changes, .. }) if *head == pr.head)
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

fn unbound(task: &Task, observation: &Observation) -> Signal {
    if matches!(
        task.phase,
        Phase::Working | Phase::Reviewing | Phase::Merging | Phase::Closing
    ) {
        if let Observed::Known(Forge::Merged { pr, commit }) = &observation.forge {
            if task.phase != Phase::Closing || !task.approves(&pr.head) {
                return merged_signal(task, pr, false);
            }
            return match &observation.workspace {
                Observed::Unknown => Signal::Wait(WaitReason::WorkspaceUnknown),
                Observed::Known(Workspace::Absent) => {
                    Signal::ReadyToClose(commit.clone(), CloseWorkspace::AlreadyAbsent)
                }
                Observed::Known(Workspace::Clean(head)) if *head == pr.head => {
                    Signal::ReadyToClose(
                        commit.clone(),
                        CloseWorkspace::RemoveClean { head: head.clone() },
                    )
                }
                Observed::Known(Workspace::Dirty | Workspace::Clean(_)) => {
                    Signal::ReadyToClose(commit.clone(), CloseWorkspace::Retain)
                }
            };
        }
    }
    match task.phase {
        Phase::Queued => Signal::Admitted,
        Phase::Working => match (&task.pr, &observation.forge, &observation.workspace) {
            (Some(_), Observed::Unknown, _) => Signal::Wait(WaitReason::ForgeUnknown),
            (Some(old), Observed::Known(Forge::Open { pr, .. }), _) if old != pr => {
                Signal::HeadChanged(Phase::Working)
            }
            (_, _, Observed::Unknown) => Signal::Wait(WaitReason::WorkspaceUnknown),
            (_, _, Observed::Known(_)) => launch(task, observation, Role::Worker),
        },
        Phase::Reviewing => match (&observation.forge, &observation.workspace) {
            (Observed::Unknown, _) => Signal::Wait(WaitReason::ForgeUnknown),
            (Observed::Known(Forge::Open { pr, .. }), _) if Some(pr) != task.pr.as_ref() => {
                Signal::HeadChanged(Phase::Reviewing)
            }
            (Observed::Known(Forge::Open { .. }), Observed::Unknown) => {
                Signal::Wait(WaitReason::WorkspaceUnknown)
            }
            (Observed::Known(Forge::Open { .. }), Observed::Known(Workspace::Absent)) => {
                launch(task, observation, Role::Reviewer)
            }
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
        Phase::Merging => match &observation.forge {
            Observed::Known(Forge::Open { pr, .. }) if !task.approves(&pr.head) => {
                Signal::NeedsReview
            }
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
                checks: CheckState::Blocked,
                ..
            }) => Signal::Question(Question::Repair(Repair::MergeBlocked)),
            Observed::Known(Forge::Open {
                pr,
                checks: CheckState::Ready,
            }) => Signal::ReadyToMerge(pr.head.clone()),
            Observed::Known(_) => {
                Signal::Question(Question::Repair(Repair::PullRequestUnavailable))
            }
        },
        Phase::Closing => match &observation.forge {
            Observed::Unknown => Signal::Wait(WaitReason::ForgeUnknown),
            Observed::Known(_) => Signal::Question(Question::Repair(Repair::MergeUnconfirmed)),
        },
        Phase::Done | Phase::Cancelled => Signal::Finished,
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
            RetainedThread::Idle => Signal::Start(
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

    pub(crate) fn current(&self, expected: &str) -> Option<RunState> {
        match &self.host {
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
