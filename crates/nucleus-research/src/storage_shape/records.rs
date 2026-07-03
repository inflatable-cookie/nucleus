//! Serializable research storage records.

use serde::{Deserialize, Serialize};

/// Storage version used by the first research JSON payloads.
pub const RESEARCH_STORAGE_SCHEMA_VERSION: u16 = 1;

/// Serializable research run brief record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchRunBriefStorageRecord {
    pub schema_version: u16,
    pub run_id: String,
    pub project_id: Option<String>,
    pub title: String,
    pub brief_summary: String,
    pub brief_detail: Option<String>,
    pub status: ResearchRunBriefStorageStatus,
    pub scope_boundary: ResearchRunScopeStorageBoundary,
    #[serde(default)]
    pub source_plan_refs: Vec<String>,
    pub confidence: ResearchConfidenceStorage,
    pub coverage: ResearchCoverageStorageSummary,
    #[serde(default)]
    pub questions: Vec<ResearchQuestionStorageRecord>,
    #[serde(default)]
    pub source_refs: Vec<ResearchSourceStorageRef>,
    #[serde(default)]
    pub observation_refs: Vec<ResearchObservationStorageRecord>,
    #[serde(default)]
    pub synthesis_refs: Vec<ResearchSynthesisStorageRef>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub synthesized_at: Option<String>,
    pub accepted_at: Option<String>,
}

/// Serializable research run status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchRunBriefStorageStatus {
    Proposed,
    Active,
    Paused,
    Blocked,
    Synthesized,
    Accepted,
    Superseded,
    Archived,
}

impl ResearchRunBriefStorageStatus {
    /// Storage status does not grant execution authority.
    pub fn grants_execution_authority(&self) -> bool {
        false
    }
}

/// Serializable scope boundary.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchRunScopeStorageBoundary {
    #[serde(default)]
    pub in_scope: Vec<String>,
    #[serde(default)]
    pub out_of_scope: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
}

impl ResearchRunScopeStorageBoundary {
    /// Scope records do not grant source access authority.
    pub fn grants_source_access_authority(&self) -> bool {
        false
    }
}

/// Serializable confidence signal.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchConfidenceStorage {
    Unknown,
    Low,
    Medium,
    High,
}

/// Serializable coverage summary.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchCoverageStorageSummary {
    #[serde(default)]
    pub covered_refs: Vec<String>,
    #[serde(default)]
    pub gap_refs: Vec<String>,
    pub note: Option<String>,
}

/// Serializable research question.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchQuestionStorageRecord {
    pub question_id: String,
    pub run_id: String,
    pub text: String,
    pub priority: ResearchQuestionStoragePriority,
    pub status: ResearchQuestionStorageStatus,
    #[serde(default)]
    pub source_requirements: Vec<ResearchQuestionSourceRequirementStorage>,
    pub answer_summary: Option<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub open_gap_refs: Vec<String>,
}

impl ResearchQuestionStorageRecord {
    /// Question records do not execute crawlers, browsers, providers, or
    /// promotion flows.
    pub fn grants_execution_authority(&self) -> bool {
        false
    }
}

/// Serializable question priority.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchQuestionStoragePriority {
    Low,
    Normal,
    High,
    Critical,
}

/// Serializable question status.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchQuestionStorageStatus {
    Open,
    InProgress,
    Answered,
    Blocked,
    Deferred,
    Superseded,
}

/// Serializable source requirement hint.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchQuestionSourceRequirementStorage {
    pub label: String,
    pub required: bool,
}

/// Serializable source provenance record.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchSourceStorageRef {
    pub source_id: String,
    pub run_id: String,
    pub kind: ResearchSourceStorageKind,
    pub locator: String,
    pub accessed_at: Option<String>,
    pub author_or_publisher: Option<String>,
    pub published_or_updated_at: Option<String>,
    pub retrieval_method: ResearchRetrievalStorageMethodHint,
    pub reliability: ResearchSourceStorageReliability,
    pub quote_or_license_note: Option<String>,
    #[serde(default)]
    pub retained_artifact_refs: Vec<String>,
}

impl ResearchSourceStorageRef {
    /// Source records preserve provenance. They do not store raw source bodies.
    pub fn stores_raw_source_payload(&self) -> bool {
        false
    }

    /// Retrieval method is metadata, not authority to retrieve.
    pub fn grants_retrieval_authority(&self) -> bool {
        false
    }

    /// Model-generated leads are not evidence by default.
    pub fn is_evidence_by_default(&self) -> bool {
        !matches!(self.kind, ResearchSourceStorageKind::ModelGeneratedLead)
    }
}

/// Serializable source kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ResearchSourceStorageKind {
    WebPage,
    OfficialDocs,
    SourceRepository,
    CodeFile,
    IssueOrDiscussion,
    Paper,
    Pdf,
    PackageRegistry,
    LocalFile,
    HumanNote,
    ModelGeneratedLead,
    Custom(String),
}

/// Serializable retrieval method hint.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "method", content = "value", rename_all = "snake_case")]
pub enum ResearchRetrievalStorageMethodHint {
    Planned,
    Manual,
    Browser,
    Api,
    LocalFile,
    RepositoryCheckout,
    ModelGeneratedLead,
    Custom(String),
}

/// Serializable source reliability posture.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchSourceStorageReliability {
    Unknown,
    Official,
    Primary,
    Secondary,
    Community,
    ModelLead,
    Low,
}

/// Serializable observation ref.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchObservationStorageRecord {
    pub observation_id: String,
    pub run_id: String,
    #[serde(default)]
    pub source_refs: Vec<String>,
    pub kind: ResearchObservationStorageKind,
    pub summary: String,
    pub evidence_ref: Option<String>,
}

impl ResearchObservationStorageRecord {
    /// Observations classify findings only.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}

/// Serializable observation kind.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResearchObservationStorageKind {
    Evidence,
    Inference,
    Speculation,
    Recommendation,
}

/// Serializable synthesis ref.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchSynthesisStorageRef {
    pub synthesis_id: String,
    pub run_id: String,
    pub kind: ResearchSynthesisStorageKind,
    #[serde(default)]
    pub observation_refs: Vec<String>,
    #[serde(default)]
    pub source_coverage_refs: Vec<String>,
    pub confidence: ResearchConfidenceStorage,
    #[serde(default)]
    pub gap_refs: Vec<String>,
    pub promotion_targets: ResearchPromotionTargetStorageRefs,
}

impl ResearchSynthesisStorageRef {
    /// Synthesis refs do not promote into target domains by themselves.
    pub fn grants_promotion_authority(&self) -> bool {
        false
    }
}

/// Serializable synthesis kind.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ResearchSynthesisStorageKind {
    Answer,
    Recommendation,
    DecisionSupport,
    PlanningInput,
    TaskSeedGroup,
    Custom(String),
}

/// Serializable promotion target refs.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResearchPromotionTargetStorageRefs {
    #[serde(default)]
    pub memory_proposal_refs: Vec<String>,
    #[serde(default)]
    pub planning_artifact_refs: Vec<String>,
    #[serde(default)]
    pub task_seed_refs: Vec<String>,
    #[serde(default)]
    pub source_evidence_refs: Vec<String>,
}

impl ResearchPromotionTargetStorageRefs {
    /// Promotion target refs do not mutate target domains.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}

/// Research storage codec error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchRecordCodecError {
    pub reason: String,
}

fn codec_error(error: serde_json::Error) -> ResearchRecordCodecError {
    ResearchRecordCodecError {
        reason: error.to_string(),
    }
}

/// Encode a research storage record as JSON.
pub fn encode_research_run_brief_storage_payload(
    record: &ResearchRunBriefStorageRecord,
) -> Result<Vec<u8>, ResearchRecordCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

/// Decode a research storage record from JSON.
pub fn decode_research_run_brief_storage_record(
    bytes: &[u8],
) -> Result<ResearchRunBriefStorageRecord, ResearchRecordCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}
