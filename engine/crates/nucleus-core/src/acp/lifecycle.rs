//! The task lifecycle view shared by the board and ACP plan.

use serde::{Deserialize, Serialize};

use crate::profiles::Provider;

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
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub thread: String,
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
