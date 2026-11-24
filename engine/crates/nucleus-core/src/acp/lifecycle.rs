//! The task lifecycle view shared by the board and ACP plan.

use serde::{Deserialize, Serialize};

use crate::{Head, Phase, Question, Review, Role, Verdict, profiles::Provider};

/// A display projection of the committed task and its audit.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub steps: Vec<Step>,
    pub admitted_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub review_round: Option<u64>,
    pub completed_reviews: Option<u64>,
    pub worker: Option<Participant>,
    pub reviewer: Option<Participant>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub thread: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_url: Option<String>,
    pub provider: Option<Provider>,
    pub model: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub key: StepKey,
    pub label: String,
    pub state: StepState,
    pub tone: StepTone,
    pub note: Option<String>,
    pub round_label: Option<String>,
    pub elapsed_ms: Option<u64>,
    pub active_since_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKey {
    Queued,
    Working,
    Review,
    Merge,
    Close,
    ReportReady,
    Done,
}

impl StepKey {
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Queued => "Queued",
            Self::Working => "Working",
            Self::Review => "Review",
            Self::Merge => "Merge",
            Self::Close => "Close",
            Self::ReportReady => "Report ready",
            Self::Done => "Done",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Todo,
    Current,
    Done,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepTone {
    Accent,
    Danger,
    Warning,
    Success,
    Muted,
}
/// Presentation facts stored alongside the engine event that established them.
#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Milestone {
    RunStarted {
        instance: String,
        role: Role,
        purpose: String,
        review_head: Option<Head>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thread: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        thread_url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider: Option<Provider>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        round: Option<u64>,
    },
    RunReported {
        instance: String,
        sent_at_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<Outcome>,
    },
    RunEnded {
        instance: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<Outcome>,
    },
    PullRequest {
        url: String,
    },
    Verdict {
        verdict: Verdict,
    },
    Question {
        question: Question,
    },
    Merged {
        commit: Head,
    },
    Finished {
        phase: Phase,
        previous_phase: Option<Phase>,
    },
}

/// The displayable part of an authenticated result. Full evidence stays with the run.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Outcome {
    Work {
        url: String,
        summary: Option<String>,
        revision: bool,
    },
    Review {
        decision: Review,
        summary: String,
        finding_titles: Vec<String>,
        change_url: Option<String>,
    },
    Report {
        summary: String,
    },
    Blocked {
        reason: String,
    },
    Question {
        question: Question,
    },
}

/// A run starts at its first recorded send. Its report duration uses the send
/// that received the report, including after a proven retry.
#[derive(Debug, Default)]
pub struct RunClock {
    pub started_at_ms: Option<u64>,
    sent_at_ms: Option<u64>,
    elapsed_ms: Option<u64>,
}

impl RunClock {
    pub fn sent(&mut self, at_ms: u64) {
        if self.elapsed_ms.is_none() {
            self.started_at_ms.get_or_insert(at_ms);
            self.sent_at_ms = Some(at_ms);
        }
    }

    pub fn reported(&mut self, at_ms: u64, sent_at_ms: Option<u64>) {
        if self.elapsed_ms.is_none() {
            self.elapsed_ms = sent_at_ms
                .or(self.sent_at_ms)
                .and_then(|sent| at_ms.checked_sub(sent));
        }
    }

    #[must_use]
    pub const fn elapsed_ms(&self) -> Option<u64> {
        self.elapsed_ms
    }
}
