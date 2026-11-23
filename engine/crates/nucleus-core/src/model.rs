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
    pub(crate) fn approves(&self, target: &Head) -> bool {
        match self {
            Self::Reviewed {
                head,
                decision: Review::Approve,
                ..
            }
            | Self::Accepted { head, .. } => head == target,
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
pub struct CredentialDigest(pub [u8; 32]);

impl fmt::Debug for CredentialDigest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CredentialDigest([redacted])")
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
    pub credential: CredentialDigest,
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
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Threads {
    pub(crate) worker: Option<String>,
    pub(crate) reviewer: Option<String>,
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
pub struct Task {
    pub(crate) identity: Identity,
    pub(crate) brief: Brief,
    pub(crate) phase: Phase,
    pub(crate) threads: Threads,
    pub(crate) run: Option<Run>,
    pub(crate) pr: Option<PullRequest>,
    pub(crate) verdict: Option<Verdict>,
    pub(crate) attempts: u8,
    pub(crate) question: Option<Question>,
    pub(crate) hold: Option<Hold>,
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
    pub const fn question(&self) -> Option<&Question> {
        self.question.as_ref()
    }

    #[must_use]
    pub const fn hold(&self) -> Option<&Hold> {
        self.hold.as_ref()
    }

    pub(crate) fn approves(&self, head: &Head) -> bool {
        self.verdict
            .as_ref()
            .is_some_and(|verdict| verdict.approves(head))
    }

    pub(crate) fn observe_pr(&mut self, pr: &PullRequest) {
        if self.pr.as_ref() != Some(pr) {
            self.attempts = 0;
            if matches!(&self.question, Some(Question::Accept { head }) if &pr.head != head) {
                self.question = None;
            }
            self.pr = Some(pr.clone());
        }
    }
}
