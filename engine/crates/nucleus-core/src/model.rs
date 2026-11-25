use std::{fmt, path::PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::profiles::{BoundProfile, Profile};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Queued,
    Working,
    ReportReady,
    Blocked,
    Error,
    Reviewing,
    Merging,
    Closing,
    Done,
    Cancelled,
}

impl Phase {
    #[must_use]
    pub const fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Cancelled)
    }

    pub(crate) const fn role(self) -> Option<Role> {
        match self {
            Self::Working => Some(Role::Worker),
            Self::Reviewing => Some(Role::Reviewer),
            Self::Queued
            | Self::ReportReady
            | Self::Blocked
            | Self::Error
            | Self::Merging
            | Self::Closing
            | Self::Done
            | Self::Cancelled => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Worker,
    Reviewer,
}

impl Role {
    pub(crate) const fn other(self) -> Self {
        match self {
            Self::Worker => Self::Reviewer,
            Self::Reviewer => Self::Worker,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Entry {
    Brief,
    ReviewEntry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub id: String,
    pub reference: String,
    pub repository: String,
    pub base: String,
    pub entry: Entry,
    #[serde(default)]
    pub origin_thread: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brief {
    pub text: String,
    pub version: u64,
    pub digest: [u8; 32],
}

impl Brief {
    pub(crate) fn new(text: String, version: u64) -> Self {
        let digest = Sha256::digest(text.as_bytes()).into();
        Self {
            text,
            version,
            digest,
        }
    }

    /// A title supplied in the brief's YAML frontmatter.
    #[must_use]
    pub fn declared_title(&self) -> Option<String> {
        let front = Self::frontmatter(&self.text).ok()??;
        let values: yaml_serde::Value = yaml_serde::from_str(front).ok()?;
        values.get("title")?.as_str().map(str::to_owned)
    }

    pub(crate) fn frontmatter(text: &str) -> Result<Option<&str>, ()> {
        let Some((first, body)) = text.split_once('\n') else {
            return Ok(None);
        };
        if first.trim_end_matches('\r') != "---" {
            return Ok(None);
        }
        let mut offset = 0;
        for line in body.split_inclusive('\n') {
            if line.trim_end_matches(['\r', '\n']) == "---" {
                return Ok(Some(&body[..offset]));
            }
            offset += line.len();
        }
        Err(())
    }
}

/// A full GitHub commit SHA, normalized to lowercase.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Head(String);

impl Head {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for Head {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl std::str::FromStr for Head {
    type Err = InvalidHead;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            Ok(Self(value.to_ascii_lowercase()))
        } else {
            Err(InvalidHead)
        }
    }
}

impl TryFrom<String> for Head {
    type Error = InvalidHead;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        value.parse()
    }
}

impl From<Head> for String {
    fn from(value: Head) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidHead;

impl fmt::Display for InvalidHead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("expected a full 40-character commit SHA")
    }
}

impl std::error::Error for InvalidHead {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    pub url: String,
    pub head: Head,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Review {
    Approve,
    Changes,
}

/// The service resolves this against the authenticated caller and task's repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Authority {
    Planner { actor: String },
    Operator { actor: String },
}

impl Authority {
    pub(crate) const fn can_accept(&self, entry: Entry) -> bool {
        matches!(
            (self, entry),
            (Self::Operator { .. }, _) | (Self::Planner { .. }, Entry::Brief)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Acceptance {
    pub authority: Authority,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Reviewed {
        head: Head,
        decision: Review,
        summary: String,
    },
    Accepted {
        head: Head,
        acceptance: Acceptance,
    },
}

impl Verdict {
    pub(crate) fn approves(&self, entry: Entry, target: &Head) -> bool {
        match self {
            Self::Reviewed {
                head,
                decision: Review::Approve,
                ..
            } => head == target,
            Self::Accepted { head, acceptance } => {
                head == target && acceptance.authority.can_accept(entry)
            }
            Self::Reviewed {
                decision: Review::Changes,
                ..
            } => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Question {
    Work {
        prompt: String,
        options: Vec<String>,
    },
    Retry {
        role: Role,
    },
    Accept {
        head: Head,
    },
    Allowance {
        used_ms: u64,
        limit_ms: u64,
    },
    Repair(Repair),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OpenQuestion {
    pub(crate) head: Option<Head>,
    pub(crate) question: Question,
    #[serde(default)]
    pub(crate) delivery: Option<QuestionDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) operator_decline: Option<OperatorDecline>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperatorDecline {
    NoticePending,
    Notified,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionDelivery {
    pub thread: String,
    pub command: String,
    pub payload: String,
    pub last_send_at_ms: Option<u64>,
}

impl fmt::Debug for QuestionDelivery {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("QuestionDelivery")
            .field("thread", &self.thread)
            .field("command", &self.command)
            .finish_non_exhaustive()
    }
}

impl OpenQuestion {
    pub(crate) fn outdated_at(&self, head: &Head) -> bool {
        self.head.as_ref() != Some(head)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Repair {
    PullRequestUnavailable,
    WorkspaceHeadMismatch,
    RevisionHasSameHead,
    MergeBlocked,
    MergeUnconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<HoldBy>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldBy {
    Operator,
    Planner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Report {
    Work(WorkReport),
    ReportReady(ReportDelivery),
    Blocked(ReportFailure),
    Error(ReportFailure),
    Review {
        head: Head,
        decision: Review,
        summary: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        finding_titles: Vec<String>,
    },
    Question {
        prompt: String,
        options: Vec<String>,
    },
}

/// A worker's PR and the optional summary supplied with older and newer callbacks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkReport {
    #[serde(flatten)]
    pub pull_request: PullRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl From<PullRequest> for WorkReport {
    fn from(pull_request: PullRequest) -> Self {
        Self {
            pull_request,
            summary: None,
        }
    }
}

/// An exact version and digest of a durable lane document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportArtifact {
    pub key: String,
    pub version: u64,
    pub digest: String,
}

/// The worker's completed qualification record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportDelivery {
    pub artifact: ReportArtifact,
    #[serde(default)]
    pub headline: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub head: Option<Head>,
}

/// A report-only turn that could not deliver its qualification record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReportFailure {
    pub summary: String,
    #[serde(default)]
    pub headline: Option<String>,
    #[serde(default)]
    pub head: Option<Head>,
}

impl Report {
    pub(crate) fn source_head(&self) -> Option<&Head> {
        match self {
            Self::ReportReady(delivery) => delivery.head.as_ref(),
            Self::Blocked(failure) | Self::Error(failure) => failure.head.as_ref(),
            _ => None,
        }
    }
}

/// The accepted report and its exact owner decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportAcceptance {
    pub version: i64,
    pub artifact: ReportArtifact,
    pub owner: Acceptance,
}

/// Durable task-scoped report routing and delivery custody.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReportTask {
    pub project: String,
    pub lane: String,
    pub planning_base: Head,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub delivery: Option<ReportDelivery>,
    #[serde(default)]
    pub failure: Option<String>,
    #[serde(default)]
    pub notice_attempted: bool,
    #[serde(default)]
    pub acceptance: Option<ReportAcceptance>,
    #[serde(default)]
    pub reported_heads: Vec<Head>,
    #[serde(default)]
    pub(crate) receipts: Vec<ReportReceipt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ReportReceipt {
    pub(crate) instance: String,
    pub(crate) credential: CredentialDigest,
    pub(crate) report: Report,
}

/// Only the digest of the bearer is stored. Its debug form is safe for diagnostics.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CredentialDigest(pub(crate) [u8; 32]);

impl fmt::Debug for CredentialDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialDigest([redacted])")
    }
}

/// Inputs for forming a new reservation. The task assigns its own identity.
#[derive(Clone)]
pub struct LaunchInputs {
    pub thread: String,
    pub started_at: u64,
    pub input: String,
    pub scratch: Option<PathBuf>,
}

impl fmt::Debug for LaunchInputs {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LaunchInputs")
            .field("thread", &self.thread)
            .finish_non_exhaustive()
    }
}

/// Returned once when a run is reserved. The caller prepares the owner-only ticket.
pub struct CallbackCredential(pub(crate) [u8; 32]);

impl CallbackCredential {
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for CallbackCredential {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CallbackCredential([redacted])")
    }
}

/// The first send and any verified replay use these same inputs.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedLaunch {
    pub instance: String,
    pub thread: String,
    pub role: Role,
    pub label: String,
    pub started_at: u64,
    pub(crate) credential: CredentialDigest,
    pub input: String,
    pub review_head: Option<Head>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) profile: Option<BoundProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) subscription_group: Option<String>,
}

impl PreparedLaunch {
    #[must_use]
    pub fn profile(&self) -> Option<&Profile> {
        self.profile.as_ref().map(|bound| &bound.selected)
    }

    #[must_use]
    pub fn subscription_group(&self) -> Option<&str> {
        self.subscription_group.as_deref()
    }
}

impl fmt::Debug for PreparedLaunch {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedLaunch")
            .field("instance", &self.instance)
            .field("thread", &self.thread)
            .field("role", &self.role)
            .field("label", &self.label)
            .field("review_head", &self.review_head)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Run {
    pub(crate) launch: PreparedLaunch,
    pub(crate) report: Option<Report>,
    pub(crate) revoked: bool,
    #[serde(default)]
    pub(crate) last_send_at_ms: Option<u64>,
    #[serde(default)]
    pub(crate) rejected_awaiting_archive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) report_reminder_for: Option<String>,
}

impl Run {
    #[must_use]
    pub fn launch(&self) -> &PreparedLaunch {
        &self.launch
    }

    #[must_use]
    pub const fn report(&self) -> Option<&Report> {
        self.report.as_ref()
    }

    #[must_use]
    pub const fn revoked(&self) -> bool {
        self.revoked
    }

    #[must_use]
    pub const fn last_send_at_ms(&self) -> Option<u64> {
        self.last_send_at_ms
    }

    /// A definite rejection still requires confirmation of reviewer archival.
    #[must_use]
    pub const fn rejected_awaiting_archive(&self) -> bool {
        self.rejected_awaiting_archive
    }

    #[must_use]
    pub fn report_reminder_for(&self) -> Option<&str> {
        self.report_reminder_for.as_deref()
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Threads {
    pub(crate) worker: Option<String>,
    pub(crate) reviewer: Option<String>,
    pub(crate) launch_sequence: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) worker_profile: Option<BoundProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reviewer_profile: Option<BoundProfile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) applied_review_sequence: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) settled_scratch: Option<PathBuf>,
}

impl Threads {
    #[must_use]
    pub fn get(&self, role: Role) -> Option<&str> {
        match role {
            Role::Worker => self.worker.as_deref(),
            Role::Reviewer => self.reviewer.as_deref(),
        }
    }

    #[must_use]
    pub fn profile(&self, role: Role) -> Option<&Profile> {
        match role {
            Role::Worker => self.worker_profile.as_ref(),
            Role::Reviewer => self.reviewer_profile.as_ref(),
        }
        .map(|bound| &bound.selected)
    }

    pub(crate) fn bind(&mut self, launch: &PreparedLaunch) {
        let (thread, profile) = match launch.role {
            Role::Worker => (&mut self.worker, &mut self.worker_profile),
            Role::Reviewer => (&mut self.reviewer, &mut self.reviewer_profile),
        };
        if thread.as_ref() != Some(&launch.thread) || launch.profile.is_some() {
            profile.clone_from(&launch.profile);
        }
        *thread = Some(launch.thread.clone());
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WorkContinuation {
    pub(crate) instruction: String,
    pub(crate) require_new_head_from: Option<Head>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "StoredTask")]
pub struct Task {
    pub(crate) identity: Identity,
    pub(crate) brief: Brief,
    pub(crate) phase: Phase,
    pub(crate) threads: Threads,
    pub(crate) run: Option<Run>,
    pub(crate) pr: Option<PullRequest>,
    pub(crate) verdict: Option<Verdict>,
    pub(crate) attempts: u8,
    pub(crate) question: Option<OpenQuestion>,
    pub(crate) hold: Option<Hold>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) work_continuation: Option<WorkContinuation>,
    #[serde(rename = "report_task", skip_serializing_if = "Option::is_none")]
    pub(crate) report_state: Option<ReportTask>,
}

#[derive(Deserialize)]
struct StoredTask {
    identity: Identity,
    brief: Brief,
    phase: Phase,
    threads: Threads,
    run: Option<Run>,
    pr: Option<PullRequest>,
    verdict: Option<Verdict>,
    attempts: u8,
    question: Option<OpenQuestion>,
    hold: Option<Hold>,
    #[serde(default)]
    work_continuation: Option<WorkContinuation>,
    #[serde(rename = "report_task")]
    report_state: Option<ReportTask>,
}

impl TryFrom<StoredTask> for Task {
    type Error = String;

    fn try_from(stored: StoredTask) -> Result<Self, Self::Error> {
        let digest: [u8; 32] = Sha256::digest(stored.brief.text.as_bytes()).into();
        if stored.brief.digest != digest {
            return Err(format!(
                "stored brief digest does not match the text for task {}",
                stored.identity.id
            ));
        }
        if matches!(&stored.verdict, Some(Verdict::Accepted { acceptance, .. }) if !acceptance.authority.can_accept(stored.identity.entry))
        {
            return Err("stored acceptance is not authorized for this task entry".into());
        }
        if (matches!(
            stored.phase,
            Phase::ReportReady | Phase::Blocked | Phase::Error
        ) && stored.report_state.is_none())
            || stored.report_state.as_ref().is_some_and(|report| {
                stored.identity.entry != Entry::Brief
                    || stored.pr.is_some()
                    || stored.verdict.is_some()
                    || matches!(
                        stored.phase,
                        Phase::Reviewing | Phase::Merging | Phase::Closing
                    )
                    || (stored.phase == Phase::ReportReady && report.delivery.is_none())
                    || (stored.phase == Phase::Done && report.acceptance.is_none())
            })
        {
            return Err("stored report-only delivery does not match its task".into());
        }
        if stored.attempts > 3 {
            return Err("stored attempt count exceeds the retry limit".into());
        }
        if stored.question.as_ref().is_some_and(|open| {
            open.operator_decline.is_some()
                && (stored.identity.entry != Entry::ReviewEntry
                    || !matches!(&open.question, Question::Accept { head } if open.head.as_ref() == Some(head)))
        }) {
            return Err("stored operator decline does not match its acceptance question".into());
        }
        if stored.run.as_ref().is_some_and(|run| {
            let role = run.launch.role;
            (!run.revoked && stored.phase.role() != Some(role))
                || (role == Role::Reviewer) != run.launch.review_head.is_some()
                || stored.threads.get(role.other()) == Some(run.launch.thread.as_str())
                || (run.last_send_at_ms.is_some()
                    && stored.threads.get(role) != Some(run.launch.thread.as_str()))
                || (run.rejected_awaiting_archive
                    && (!run.revoked || role != Role::Reviewer || run.last_send_at_ms.is_none()))
                || run.launch.instance
                    != format!(
                        "task-{}-run-{}",
                        stored.identity.id, stored.threads.launch_sequence
                    )
        }) {
            return Err("stored run does not match its task reservation".into());
        }
        Ok(Self {
            identity: stored.identity,
            brief: stored.brief,
            phase: stored.phase,
            threads: stored.threads,
            run: stored.run,
            pr: stored.pr,
            verdict: stored.verdict,
            attempts: stored.attempts,
            question: stored.question,
            hold: stored.hold,
            work_continuation: stored.work_continuation,
            report_state: stored.report_state,
        })
    }
}

impl Task {
    #[must_use]
    pub fn new(identity: Identity, brief: String, pr: Option<PullRequest>) -> Self {
        let phase = match identity.entry {
            Entry::Brief => Phase::Queued,
            Entry::ReviewEntry => Phase::Reviewing,
        };
        Self {
            identity,
            brief: Brief::new(brief, 1),
            phase,
            threads: Threads::default(),
            run: None,
            pr,
            verdict: None,
            attempts: 0,
            question: None,
            hold: None,
            work_continuation: None,
            report_state: None,
        }
    }

    /// Admit a report-only task with one proved lane and an immutable planning base.
    #[must_use]
    pub fn new_report_only(
        identity: Identity,
        brief: String,
        project: String,
        lane: String,
        planning_base: Head,
    ) -> Self {
        let mut task = Self::new(identity, brief, None);
        task.report_state = Some(ReportTask {
            project,
            lane,
            planning_base,
            instruction: None,
            delivery: None,
            failure: None,
            notice_attempted: false,
            acceptance: None,
            reported_heads: Vec::new(),
            receipts: Vec::new(),
        });
        task
    }

    /// The instruction to freeze in the next code worker assignment.
    #[must_use]
    pub fn work_instruction(&self) -> Option<&str> {
        self.work_continuation
            .as_ref()
            .map(|work| work.instruction.as_str())
    }

    /// Read the report-only delivery state, if the task opted in at admission.
    #[must_use]
    pub const fn report_task(&self) -> Option<&ReportTask> {
        self.report_state.as_ref()
    }

    /// Fence the initial planner notification before attempting native delivery.
    pub fn mark_report_notice_attempted(&mut self) {
        if self.phase == Phase::ReportReady
            && let Some(report) = &mut self.report_state
        {
            report.notice_attempted = true;
        }
    }

    /// Open the planner notice for a newly settled revision of the artifact.
    pub fn reopen_report_notice(&mut self) {
        if self.phase == Phase::ReportReady
            && let Some(report) = &mut self.report_state
        {
            report.notice_attempted = false;
        }
    }

    #[must_use]
    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    #[must_use]
    pub fn brief(&self) -> &Brief {
        &self.brief
    }

    #[must_use]
    pub const fn phase(&self) -> Phase {
        self.phase
    }

    #[must_use]
    pub fn threads(&self) -> &Threads {
        &self.threads
    }

    #[must_use]
    pub const fn run(&self) -> Option<&Run> {
        self.run.as_ref()
    }

    #[must_use]
    pub const fn pull_request(&self) -> Option<&PullRequest> {
        self.pr.as_ref()
    }

    #[must_use]
    pub const fn verdict(&self) -> Option<&Verdict> {
        self.verdict.as_ref()
    }

    #[must_use]
    pub const fn attempts(&self) -> u8 {
        self.attempts
    }

    #[must_use]
    pub fn question(&self) -> Option<&Question> {
        self.question.as_ref().map(|open| &open.question)
    }

    /// Open the planner's question before another run can start.
    pub fn ask_allowance(&mut self, used_ms: u64, limit_ms: u64) -> bool {
        if self.phase.is_terminal()
            || self.hold.is_some()
            || self.question.is_some()
            || self
                .run
                .as_ref()
                .is_some_and(|run| run.revoked() || run.last_send_at_ms().is_some())
        {
            return false;
        }
        self.question = Some(OpenQuestion {
            head: self.pr.as_ref().map(|pr| pr.head.clone()),
            question: Question::Allowance { used_ms, limit_ms },
            delivery: None,
            operator_decline: None,
        });
        true
    }

    /// Clear the allowance question after its measured stop no longer applies.
    pub fn clear_allowance_question(&mut self) -> bool {
        if !matches!(self.question(), Some(Question::Allowance { .. })) {
            return false;
        }
        self.question = None;
        true
    }

    /// Whether the task has ever reserved a run.
    #[must_use]
    pub const fn has_reserved_run(&self) -> bool {
        self.threads.launch_sequence > 0
    }

    #[must_use]
    pub fn operator_question(&self) -> Option<&Head> {
        match self.question()? {
            Question::Accept { head } if self.identity.entry == Entry::ReviewEntry => Some(head),
            _ => None,
        }
    }

    #[must_use]
    pub fn operator_decline(&self) -> Option<OperatorDecline> {
        self.question.as_ref()?.operator_decline
    }

    /// Record a decline on the currently open operator question.
    pub fn decline_operator_question(&mut self, head: &Head) -> bool {
        if self.operator_question() != Some(head) || self.operator_decline().is_some() {
            return false;
        }
        let Some(open) = &mut self.question else {
            return false;
        };
        open.operator_decline = Some(OperatorDecline::NoticePending);
        open.delivery = None;
        true
    }

    /// Mark the planner notice delivered, leaving the task parked on the decline.
    pub fn notify_operator_decline(&mut self) -> bool {
        let Some(open) = &mut self.question else {
            return false;
        };
        if open.operator_decline != Some(OperatorDecline::NoticePending) {
            return false;
        }
        open.operator_decline = Some(OperatorDecline::Notified);
        true
    }

    #[must_use]
    pub fn question_delivery(&self) -> Option<&QuestionDelivery> {
        self.question
            .as_ref()
            .and_then(|open| open.delivery.as_ref())
    }

    /// Bind the open question to one exact host request.
    /// Returns false when there is no open question to bind.
    pub fn bind_question_delivery(&mut self, delivery: QuestionDelivery) -> bool {
        let Some(question) = &mut self.question else {
            return false;
        };
        question.delivery = Some(delivery);
        true
    }

    /// Drop only the exact notice that was proven not delivered.
    pub fn clear_question_delivery(&mut self, command: &str) -> bool {
        let Some(question) = &mut self.question else {
            return false;
        };
        if question
            .delivery
            .as_ref()
            .is_none_or(|delivery| delivery.command != command)
        {
            return false;
        }
        question.delivery = None;
        true
    }

    #[must_use]
    pub const fn hold(&self) -> Option<&Hold> {
        self.hold.as_ref()
    }

    pub(crate) fn approves(&self, head: &Head) -> bool {
        self.verdict
            .as_ref()
            .is_some_and(|verdict| verdict.approves(self.identity.entry, head))
    }

    pub(crate) fn observe_pr(&mut self, pr: &PullRequest) {
        if self
            .question
            .as_ref()
            .is_some_and(|open| open.outdated_at(&pr.head))
        {
            self.question = None;
        }
        if self.pr.as_ref() != Some(pr) {
            self.attempts = 0;
            self.pr = Some(pr.clone());
        }
    }
}
