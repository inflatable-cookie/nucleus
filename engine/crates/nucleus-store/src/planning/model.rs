use nucleus_core::ReportArtifact;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub version: u64,
    pub lanes: Vec<PlanLane>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanLane {
    pub key: String,
    pub horizon: Horizon,
    pub done_when: String,
    pub status_note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Horizon {
    Now,
    Next,
    Later,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lane {
    pub key: String,
    pub version: u64,
    #[serde(flatten)]
    pub document: LaneDocument,
    #[serde(flatten)]
    pub disposition: LaneDisposition,
}

impl Lane {
    /// Identify the exact Markdown this lane version carries.
    #[must_use]
    pub fn artifact(&self) -> ReportArtifact {
        ReportArtifact {
            key: self.key.clone(),
            version: self.version,
            digest: format!("{:x}", Sha256::digest(self.document.document.as_bytes())),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaneDocument {
    pub title: String,
    pub aim: String,
    pub document: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LaneDisposition {
    #[default]
    Open,
    Done {
        note: String,
    },
    Dropped {
        note: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: ItemKind,
    pub author: String,
    /// The project whose planner claim authenticated the author when filed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author_project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub repositories: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_links: Vec<String>,
    #[serde(flatten)]
    pub content: ItemContent,
    #[serde(flatten)]
    pub state: ItemState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemWithTimes {
    #[serde(flatten)]
    pub item: Item,
    pub version: i64,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Lead,
    Papercut,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemDisposition {
    Completed,
    #[default]
    Deprecated,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemContent {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub lanes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "state",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ItemState {
    Open,
    Parked {
        reason: String,
        revisit_at: Option<String>,
    },
    Promoted {
        task_id: String,
    },
    Dropped {
        #[serde(default)]
        disposition: ItemDisposition,
        reason: Option<String>,
    },
}

/// What a promotion requires of its item, read inside the admission transaction.
#[derive(Debug, Clone, Copy)]
pub struct PromotionCheck<'a> {
    /// The body admission read; any later edit refuses the promotion.
    pub body: &'a str,
    /// The version the caller saw, when it names one.
    pub version: Option<i64>,
    /// A new source body saved with the promotion (a lead's chosen complexity).
    pub source_body: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSource {
    pub project_id: String,
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    pub id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub input: DecisionInput,
    pub author: String,
    pub created_at_ms: u64,
    pub answer: Option<DecisionAnswer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<DecisionTarget>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub withdrawn: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionInput {
    pub question: String,
    pub options: Vec<DecisionOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DecisionOption {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAnswerInput {
    pub option_id: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAnswer {
    #[serde(flatten)]
    pub input: DecisionAnswerInput,
    pub author: String,
    pub answered_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionTarget {
    pub task_id: String,
    pub task_version: i64,
    #[serde(default, skip_serializing_if = "is_default")]
    pub kind: DecisionKind,
}

/// The task fact that gives an operator decision custody of its answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    #[default]
    Question,
    UsagePermission,
}

fn is_default<T: Default + PartialEq>(value: &T) -> bool {
    value == &T::default()
}

impl DecisionTarget {
    pub(super) fn record_id(&self) -> String {
        match self.kind {
            DecisionKind::Question => format!("task-{}-{}", self.task_id, self.task_version),
            DecisionKind::UsagePermission => format!("usage-permission-{}", self.task_id),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    Plan,
    Lane,
    Item,
    Decision,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub sequence: i64,
    pub actor: String,
    pub at_ms: i64,
    pub action: String,
    pub snapshot: Value,
}

#[derive(Debug, Clone, Copy)]
pub struct WriteAt<'a> {
    pub actor: &'a str,
    pub at_ms: u64,
}
