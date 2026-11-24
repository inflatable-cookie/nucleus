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
    pub worker: Option<Participant>,
    pub reviewer: Option<Participant>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<Transcript>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub thread: String,
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_instance: Option<String>,
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
        provider: Option<Provider>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        model_observed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        started_at_ms: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        round: Option<u64>,
    },
    RunRouting {
        instance: String,
        provider_instance: String,
        provider: Option<Provider>,
        model: String,
    },
    RunReported {
        instance: String,
        sent_at_ms: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        outcome: Option<Outcome>,
    },
    RunEnded {
        instance: String,
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

/// Role facts from the same audit as the lifecycle steps.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub cards: Vec<RoleCard>,
    pub completed_reviews: u64,
    pub merged: bool,
    pub question: Option<Question>,
    pub question_url: Option<String>,
    pub question_owner: Option<String>,
    pub external_acceptances: Vec<(i64, String)>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleCard {
    pub instance: String,
    pub role: Role,
    pub purpose: String,
    pub thread_url: Option<String>,
    pub provider: Option<Provider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_instance: Option<String>,
    pub model: Option<String>,
    /// The provider and model come from the exact native run, when recorded.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub model_observed: bool,
    pub started_at_ms: Option<u64>,
    pub elapsed_ms: Option<u64>,
    pub ended: bool,
    pub outcome: Option<Outcome>,
    pub activity: Option<String>,
}
