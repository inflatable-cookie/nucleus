use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Queued,
    Working,
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
            Self::Queued | Self::Merging | Self::Closing | Self::Done | Self::Cancelled => None,
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
    Repair(Repair),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OpenQuestion {
    pub(crate) head: Option<Head>,
    pub(crate) question: Question,
    #[serde(default)]
    pub(crate) delivery: Option<QuestionDelivery>,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Report {
    Work(PullRequest),
    Review {
        head: Head,
        decision: Review,
        summary: String,
    },
    Question {
        prompt: String,
        options: Vec<String>,
    },
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Threads {
    pub(crate) worker: Option<String>,
    pub(crate) reviewer: Option<String>,
    pub(crate) launch_sequence: u64,
}

impl Threads {
    #[must_use]
    pub fn get(&self, role: Role) -> Option<&str> {
        match role {
            Role::Worker => self.worker.as_deref(),
            Role::Reviewer => self.reviewer.as_deref(),
        }
    }

    pub(crate) fn set(&mut self, role: Role, thread: String) {
        match role {
            Role::Worker => self.worker = Some(thread),
            Role::Reviewer => self.reviewer = Some(thread),
        }
    }
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
}

impl TryFrom<StoredTask> for Task {
    type Error = &'static str;

    fn try_from(stored: StoredTask) -> Result<Self, Self::Error> {
        if matches!(&stored.verdict, Some(Verdict::Accepted { acceptance, .. }) if !acceptance.authority.can_accept(stored.identity.entry))
        {
            return Err("stored acceptance is not authorized for this task entry");
        }
        if stored.attempts > 3 {
            return Err("stored attempt count exceeds the retry limit");
        }
        if stored.run.as_ref().is_some_and(|run| {
            let role = run.launch.role;
            (!run.revoked && stored.phase.role() != Some(role))
                || (role == Role::Reviewer) != run.launch.review_head.is_some()
                || stored.threads.get(role) != Some(run.launch.thread.as_str())
                || run.launch.instance
                    != format!(
                        "task-{}-run-{}",
                        stored.identity.id, stored.threads.launch_sequence
                    )
        }) {
            return Err("stored run does not match its task reservation");
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
