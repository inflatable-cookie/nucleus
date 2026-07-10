//! Engine-owned checkpoint and diff summary records.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct EngineCheckpointRecordId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct EngineDiffSummaryRecordId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineCheckpointFamily {
    TaskWork,
    AgentSession,
    Thread,
    Turn,
    ScmChangeWorkflow,
    ValidationRun,
    ResearchRun,
    StewardOperation,
    ManualOperation,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineCheckpointRecoveryState {
    Available,
    RepairRequired,
    MissingSource,
    Superseded,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum EngineCheckpointRef {
    ProjectId(String),
    TaskId(String),
    WorkItemId(String),
    CheckpointId(String),
    AgentSessionId(String),
    ThreadId(String),
    TurnId(String),
    CommandId(String),
    EventId(String),
    ReceiptId(String),
    AuthorityHostId(String),
    ActorId(String),
    RepoId(String),
    ScmAdapterRef(String),
    SnapshotRef(String),
    PublicationRef(String),
    ArtifactRef(String),
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineCheckpointRecord {
    pub checkpoint_id: EngineCheckpointRecordId,
    pub family: EngineCheckpointFamily,
    pub primary_workflow_ref: EngineCheckpointRef,
    pub project_ref: EngineCheckpointRef,
    pub source_ref: Option<EngineCheckpointRef>,
    pub scm_adapter_ref: Option<EngineCheckpointRef>,
    pub authority_host_ref: EngineCheckpointRef,
    pub created_by_actor_ref: EngineCheckpointRef,
    pub causal_refs: Vec<EngineCheckpointRef>,
    pub parent_checkpoint_refs: Vec<EngineCheckpointRef>,
    pub artifact_refs: Vec<EngineCheckpointRef>,
    pub summary: Option<String>,
    pub recovery_state: EngineCheckpointRecoveryState,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDiffSummaryKind {
    Source,
    ManagementProjection,
    TaskState,
    MemoryProjection,
    PlanningArtifact,
    ResearchSynthesis,
    ArtifactManifest,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDiffSummaryConfidence {
    Exact,
    High,
    Partial,
    Estimated,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDiffPathChangeKind {
    Added,
    Modified,
    Deleted,
    MetadataOnly,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineDiffPathChange {
    pub file_ref: String,
    pub display_path: String,
    pub kind: EngineDiffPathChangeKind,
    pub baseline_file_ref: Option<String>,
    pub target_file_ref: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineDiffSummaryCounts {
    pub added: usize,
    pub modified: usize,
    pub deleted: usize,
    pub metadata_only: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineDiffCoverageState {
    Complete,
    Partial,
    Unavailable,
}

impl Default for EngineDiffCoverageState {
    fn default() -> Self {
        Self::Unavailable
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EngineDiffSummaryRecord {
    pub diff_id: EngineDiffSummaryRecordId,
    pub kind: EngineDiffSummaryKind,
    pub source_boundary_ref: EngineCheckpointRef,
    pub target_boundary_ref: EngineCheckpointRef,
    pub source_ref: Option<EngineCheckpointRef>,
    pub adapter_ref: Option<EngineCheckpointRef>,
    pub generated_by_ref: EngineCheckpointRef,
    pub confidence: EngineDiffSummaryConfidence,
    pub summary: String,
    pub changed_paths: Vec<String>,
    #[serde(default)]
    pub path_changes: Vec<EngineDiffPathChange>,
    #[serde(default)]
    pub counts: EngineDiffSummaryCounts,
    #[serde(default)]
    pub coverage: EngineDiffCoverageState,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub attribution_notice: Option<String>,
    pub evidence_refs: Vec<EngineCheckpointRef>,
    pub artifact_refs: Vec<EngineCheckpointRef>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointDiffCodecError {
    pub reason: String,
}

pub fn encode_checkpoint_record(
    record: &EngineCheckpointRecord,
) -> Result<Vec<u8>, CheckpointDiffCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_checkpoint_record(
    bytes: &[u8],
) -> Result<EngineCheckpointRecord, CheckpointDiffCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

pub fn encode_diff_summary_record(
    record: &EngineDiffSummaryRecord,
) -> Result<Vec<u8>, CheckpointDiffCodecError> {
    serde_json::to_vec(record).map_err(codec_error)
}

pub fn decode_diff_summary_record(
    bytes: &[u8],
) -> Result<EngineDiffSummaryRecord, CheckpointDiffCodecError> {
    serde_json::from_slice(bytes).map_err(codec_error)
}

fn codec_error(error: serde_json::Error) -> CheckpointDiffCodecError {
    CheckpointDiffCodecError {
        reason: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_record_round_trips_without_git_commit_assumption() {
        let record = EngineCheckpointRecord {
            checkpoint_id: EngineCheckpointRecordId("checkpoint:task:1".to_owned()),
            family: EngineCheckpointFamily::TaskWork,
            primary_workflow_ref: EngineCheckpointRef::TaskId("task:1".to_owned()),
            project_ref: EngineCheckpointRef::ProjectId("project:1".to_owned()),
            source_ref: Some(EngineCheckpointRef::SnapshotRef(
                "convergence:snapshot:1".to_owned(),
            )),
            scm_adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef(
                "convergence:workspace:1".to_owned(),
            )),
            authority_host_ref: EngineCheckpointRef::AuthorityHostId("host:local".to_owned()),
            created_by_actor_ref: EngineCheckpointRef::ActorId("actor:agent".to_owned()),
            causal_refs: vec![EngineCheckpointRef::CommandId("command:1".to_owned())],
            parent_checkpoint_refs: Vec::new(),
            artifact_refs: vec![EngineCheckpointRef::ArtifactRef("artifact:1".to_owned())],
            summary: Some("task checkpoint".to_owned()),
            recovery_state: EngineCheckpointRecoveryState::Available,
        };

        let bytes = encode_checkpoint_record(&record).expect("encode checkpoint");
        let decoded = decode_checkpoint_record(&bytes).expect("decode checkpoint");
        let json = String::from_utf8(bytes).expect("json");

        assert_eq!(decoded, record);
        assert!(!json.contains("commit"));
        assert!(!json.contains("branch"));
    }

    #[test]
    fn diff_summary_record_round_trips_without_patch_payload() {
        let record = EngineDiffSummaryRecord {
            diff_id: EngineDiffSummaryRecordId("diff:1".to_owned()),
            kind: EngineDiffSummaryKind::Source,
            source_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:before".to_owned()),
            target_boundary_ref: EngineCheckpointRef::SnapshotRef("snapshot:after".to_owned()),
            source_ref: Some(EngineCheckpointRef::RepoId("repo:1".to_owned())),
            adapter_ref: Some(EngineCheckpointRef::ScmAdapterRef(
                "adapter:convergence".to_owned(),
            )),
            generated_by_ref: EngineCheckpointRef::CommandId("command:diff".to_owned()),
            confidence: EngineDiffSummaryConfidence::Partial,
            summary: "2 paths changed".to_owned(),
            changed_paths: vec!["src/lib.rs".to_owned(), "README.md".to_owned()],
            path_changes: vec![EngineDiffPathChange {
                file_ref: "project-file:src-lib".to_owned(),
                display_path: "src/lib.rs".to_owned(),
                kind: EngineDiffPathChangeKind::Modified,
                baseline_file_ref: Some("project-file:src-lib".to_owned()),
                target_file_ref: Some("project-file:src-lib".to_owned()),
            }],
            counts: EngineDiffSummaryCounts {
                modified: 1,
                ..EngineDiffSummaryCounts::default()
            },
            coverage: EngineDiffCoverageState::Complete,
            truncated: false,
            attribution_notice: Some("task-window attribution".to_owned()),
            evidence_refs: vec![EngineCheckpointRef::ReceiptId("receipt:1".to_owned())],
            artifact_refs: Vec::new(),
        };

        let bytes = encode_diff_summary_record(&record).expect("encode diff");
        let decoded = decode_diff_summary_record(&bytes).expect("decode diff");
        let json = String::from_utf8(bytes).expect("json");

        assert_eq!(decoded, record);
        assert!(!json.contains("patch"));
        assert!(!json.contains("pull_request"));
    }
}
