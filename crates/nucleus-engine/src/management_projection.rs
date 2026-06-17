//! Repo-backed management projection planning and validation.
//!
//! This module describes shared project-management projection files without
//! performing filesystem writes, SCM operations, or live-state imports.

use nucleus_projects::ProjectStorageRecord;
use nucleus_tasks::TaskStorageRecord;
use serde::{Deserialize, Serialize};

pub const MANAGEMENT_PROJECTION_ROOT: &str = "nucleus";
pub const MANAGEMENT_PROJECTION_SCHEMA_V1: &str = "nucleus.management_projection.v1";

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionRecordId(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionFileRef(pub String);

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ManagementProjectionSchemaVersion(pub String);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionRecordKind {
    Project,
    RepoMembership,
    Task,
    Index,
    ArtifactIndex,
    PlanningArtifact,
    SharedMemory,
    ResearchSynthesis,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionEnvelope {
    pub schema_version: ManagementProjectionSchemaVersion,
    pub record_id: ManagementProjectionRecordId,
    pub record_kind: ManagementProjectionRecordKind,
    pub file_ref: ManagementProjectionFileRef,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionRoot {
    pub relative_path: String,
    pub visible_by_default: bool,
}

impl Default for ManagementProjectionRoot {
    fn default() -> Self {
        Self {
            relative_path: MANAGEMENT_PROJECTION_ROOT.to_owned(),
            visible_by_default: true,
        }
    }
}

impl ManagementProjectionSchemaVersion {
    pub fn current() -> Self {
        Self(MANAGEMENT_PROJECTION_SCHEMA_V1.to_owned())
    }
}

impl ManagementProjectionFileRef {
    pub fn project() -> Self {
        Self("nucleus/project.toml".to_owned())
    }

    pub fn repo_membership(repo_membership_id: &str) -> Self {
        Self(format!("nucleus/repos/{repo_membership_id}.toml"))
    }

    pub fn task(task_id: &str) -> Self {
        Self(format!("nucleus/tasks/{task_id}.toml"))
    }

    pub fn indexes_readme() -> Self {
        Self("nucleus/indexes/README.md".to_owned())
    }

    pub fn artifacts_readme() -> Self {
        Self("nucleus/artifacts/README.md".to_owned())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionExportPlan {
    pub root: ManagementProjectionRoot,
    pub entries: Vec<ManagementProjectionExportEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionExportEntry {
    pub envelope: ManagementProjectionEnvelope,
    pub payload: ManagementProjectionPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionFileDocument {
    pub envelope: ManagementProjectionEnvelope,
    pub payload: ManagementProjectionPayload,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionFileFormat {
    TomlV1,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "record", rename_all = "snake_case")]
pub enum ManagementProjectionPayload {
    Project(ProjectStorageRecord),
    Task(TaskStorageRecord),
    Index {
        title: String,
    },
    ArtifactIndex {
        title: String,
    },
    Unsupported {
        payload_kind: String,
        retained_payload: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManagementProjectionFileCodecError {
    pub reason: String,
}

pub fn export_project_task_projection(
    projects: &[ProjectStorageRecord],
    tasks: &[TaskStorageRecord],
) -> ManagementProjectionExportPlan {
    let mut entries = Vec::new();

    for project in projects {
        entries.push(ManagementProjectionExportEntry {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId(project.project_id.clone()),
                record_kind: ManagementProjectionRecordKind::Project,
                file_ref: ManagementProjectionFileRef::project(),
            },
            payload: ManagementProjectionPayload::Project(project.clone()),
        });
    }

    for task in tasks {
        entries.push(ManagementProjectionExportEntry {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId(task.task_id.clone()),
                record_kind: ManagementProjectionRecordKind::Task,
                file_ref: ManagementProjectionFileRef::task(&task.task_id),
            },
            payload: ManagementProjectionPayload::Task(task.clone()),
        });
    }

    ManagementProjectionExportPlan {
        root: ManagementProjectionRoot::default(),
        entries,
    }
}

pub fn encode_management_projection_file_document(
    document: &ManagementProjectionFileDocument,
) -> Result<Vec<u8>, ManagementProjectionFileCodecError> {
    toml::to_string_pretty(document)
        .map(String::into_bytes)
        .map_err(file_encode_error)
}

pub fn decode_management_projection_file_document(
    bytes: &[u8],
) -> Result<ManagementProjectionFileDocument, ManagementProjectionFileCodecError> {
    let text = std::str::from_utf8(bytes).map_err(|error| ManagementProjectionFileCodecError {
        reason: error.to_string(),
    })?;
    toml::from_str(text).map_err(file_decode_error)
}

pub fn projection_file_document_from_entry(
    entry: ManagementProjectionExportEntry,
) -> ManagementProjectionFileDocument {
    ManagementProjectionFileDocument {
        envelope: entry.envelope,
        payload: entry.payload,
    }
}

fn file_encode_error(error: toml::ser::Error) -> ManagementProjectionFileCodecError {
    ManagementProjectionFileCodecError {
        reason: error.to_string(),
    }
}

fn file_decode_error(error: toml::de::Error) -> ManagementProjectionFileCodecError {
    ManagementProjectionFileCodecError {
        reason: error.to_string(),
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionValidationStatus {
    Valid,
    ValidWithWarnings,
    Invalid,
    UnsupportedSchema,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionValidationReport {
    pub file_ref: ManagementProjectionFileRef,
    pub record_id: Option<ManagementProjectionRecordId>,
    pub status: ManagementProjectionValidationStatus,
    pub issues: Vec<ManagementProjectionValidationIssue>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionValidationIssue {
    pub kind: ManagementProjectionValidationIssueKind,
    pub field: Option<String>,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionValidationIssueKind {
    MissingRequiredField,
    InvalidIdentifier,
    UnsupportedSchemaVersion,
    UnknownRecordKind,
    InvalidReference,
    ExcludedStatePresent,
    RequiresRepair,
    Custom(String),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionExcludedStateMarker {
    SecretMaterial,
    ProviderAuthMaterial,
    ProviderNativeTranscript,
    LiveRuntimeEventStream,
    LiveAgentSession,
    TerminalState,
    BrowserState,
    LocalCache,
    LocalIndex,
    LocalClientLayoutState,
    GlobalDisplayWindowSurfaceLayout,
    PerProjectPanelLayout,
    RawValidationOutput,
    Custom(String),
}

pub fn validate_projection_envelope(
    envelope: &ManagementProjectionEnvelope,
    excluded_markers: &[ManagementProjectionExcludedStateMarker],
) -> ManagementProjectionValidationReport {
    let mut issues = Vec::new();

    if envelope.schema_version.0 != MANAGEMENT_PROJECTION_SCHEMA_V1 {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::UnsupportedSchemaVersion,
            field: Some("schema_version".to_owned()),
            summary: format!("unsupported schema version {}", envelope.schema_version.0),
        });
    }

    if envelope.record_id.0.trim().is_empty() {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::MissingRequiredField,
            field: Some("record_id".to_owned()),
            summary: "record id is required".to_owned(),
        });
    }

    if !envelope.file_ref.0.starts_with("nucleus/") {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::InvalidReference,
            field: Some("file_ref".to_owned()),
            summary: "management projection files must live under nucleus/".to_owned(),
        });
    }

    for marker in excluded_markers {
        issues.push(ManagementProjectionValidationIssue {
            kind: ManagementProjectionValidationIssueKind::ExcludedStatePresent,
            field: None,
            summary: format!("excluded state present: {marker:?}"),
        });
    }

    let status = if issues.iter().any(|issue| {
        issue.kind == ManagementProjectionValidationIssueKind::UnsupportedSchemaVersion
    }) {
        ManagementProjectionValidationStatus::UnsupportedSchema
    } else if issues.is_empty() {
        ManagementProjectionValidationStatus::Valid
    } else {
        ManagementProjectionValidationStatus::Invalid
    };

    ManagementProjectionValidationReport {
        file_ref: envelope.file_ref.clone(),
        record_id: Some(envelope.record_id.clone()),
        status,
        issues,
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ManagementProjectionConflictReport {
    pub conflict_id: String,
    pub file_ref: ManagementProjectionFileRef,
    pub local_record_ref: Option<ManagementProjectionRecordId>,
    pub incoming_record_ref: Option<ManagementProjectionRecordId>,
    pub class: ManagementProjectionConflictClass,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "class", content = "kind", rename_all = "snake_case")]
pub enum ManagementProjectionConflictClass {
    Schema(ManagementProjectionSchemaConflictKind),
    Semantic(ManagementProjectionSemanticConflictKind),
    Unsupported(ManagementProjectionUnsupportedConflictKind),
    Scm(ManagementProjectionScmConflictKind),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionSchemaConflictKind {
    InvalidRecordShape,
    UnsupportedSchema,
    MissingRequiredField,
    UnknownRecordKind,
    ExcludedStatePresent,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionSemanticConflictKind {
    ProjectIdentityMismatch,
    RepoMembershipMeaningChange,
    TaskDeletionVersusUpdate,
    IncompatibleTaskStatus,
    AcceptanceCriteriaRewrite,
    AssignmentIntentMismatch,
    MeaningfulHistoryRewrite,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionUnsupportedConflictKind {
    UnsupportedRecordKind,
    UnsupportedPayloadKind,
    UnsupportedSchemaPreserved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagementProjectionScmConflictKind {
    WorkingCopyDirty,
    FileChangedDuringExport,
    FileChangedDuringImport,
    ProjectionPathConflict,
    SyncBaseUnknown,
    AdapterConflict(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_projects::{
        ProjectStorageImportanceLevel, ProjectStorageRecord, ProjectStorageStatus,
    };
    use nucleus_tasks::{
        TaskStorageAcceptanceCriterion, TaskStorageActionType, TaskStorageActivityState,
        TaskStorageImportance, TaskStorageRecord,
    };

    #[test]
    fn management_projection_names_first_shared_file_refs() {
        assert_eq!(ManagementProjectionRoot::default().relative_path, "nucleus");
        assert!(ManagementProjectionRoot::default().visible_by_default);
        assert_eq!(
            ManagementProjectionFileRef::project().0,
            "nucleus/project.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::repo_membership("repo:one").0,
            "nucleus/repos/repo:one.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::task("task:one").0,
            "nucleus/tasks/task:one.toml"
        );
        assert_eq!(
            ManagementProjectionFileRef::indexes_readme().0,
            "nucleus/indexes/README.md"
        );
        assert_eq!(
            ManagementProjectionFileRef::artifacts_readme().0,
            "nucleus/artifacts/README.md"
        );
    }

    #[test]
    fn management_projection_export_plan_contains_only_shared_project_task_state() {
        let project = ProjectStorageRecord {
            project_id: "project:nucleus".to_owned(),
            display_name: "Nucleus".to_owned(),
            status: ProjectStorageStatus::Active,
            importance_level: ProjectStorageImportanceLevel::High,
        };
        let task = TaskStorageRecord {
            task_id: "task:projection".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Export projection".to_owned(),
            description: Some("Export shared management state.".to_owned()),
            acceptance_criteria: vec![TaskStorageAcceptanceCriterion {
                text: "Plan is management-only".to_owned(),
                required: true,
            }],
            importance: TaskStorageImportance::High,
            action_type: TaskStorageActionType::Execute,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: Some("agent:steward".to_owned()),
            agent_ready: true,
            required_context_refs: vec!["docs/contracts/011-scm-forge-sync-contract.md".to_owned()],
            allowed_actions: vec![TaskStorageActionType::Execute],
            stop_conditions: vec!["Stop before SCM mutation".to_owned()],
            validation_commands: vec!["cargo check --workspace".to_owned()],
        };

        let plan = export_project_task_projection(&[project], &[task]);
        let json = serde_json::to_string(&plan).expect("serialize plan");

        assert_eq!(plan.entries.len(), 2);
        assert!(json.contains("nucleus/project.toml"));
        assert!(json.contains("nucleus/tasks/task:projection.toml"));
        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "browser_state",
            "provider_auth",
            "client_layout",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
        ] {
            assert!(!json.contains(forbidden), "projection leaked {forbidden}");
        }
    }

    #[test]
    fn management_projection_file_document_round_trips_project_and_task_entries() {
        let project = ProjectStorageRecord {
            project_id: "project:nucleus".to_owned(),
            display_name: "Nucleus".to_owned(),
            status: ProjectStorageStatus::Active,
            importance_level: ProjectStorageImportanceLevel::High,
        };
        let task = TaskStorageRecord {
            task_id: "task:projection".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Export projection".to_owned(),
            description: None,
            acceptance_criteria: Vec::new(),
            importance: TaskStorageImportance::Normal,
            action_type: TaskStorageActionType::Execute,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: None,
            agent_ready: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskStorageActionType::Execute],
            stop_conditions: Vec::new(),
            validation_commands: Vec::new(),
        };
        let plan = export_project_task_projection(&[project], &[task]);

        let documents = plan
            .entries
            .into_iter()
            .map(projection_file_document_from_entry)
            .collect::<Vec<_>>();
        let round_tripped = documents
            .iter()
            .map(|document| {
                let bytes =
                    encode_management_projection_file_document(document).expect("encode document");
                decode_management_projection_file_document(&bytes).expect("decode document")
            })
            .collect::<Vec<_>>();

        assert_eq!(round_tripped, documents);
        assert!(round_tripped.iter().all(|document| {
            document.envelope.schema_version == ManagementProjectionSchemaVersion::current()
        }));
        assert!(round_tripped.iter().any(|document| {
            document.envelope.file_ref == ManagementProjectionFileRef::project()
        }));
        assert!(round_tripped.iter().any(|document| {
            document.envelope.file_ref == ManagementProjectionFileRef::task("task:projection")
        }));
    }

    #[test]
    fn management_projection_file_document_preserves_explicit_unsupported_payloads() {
        let document = ManagementProjectionFileDocument {
            envelope: ManagementProjectionEnvelope {
                schema_version: ManagementProjectionSchemaVersion::current(),
                record_id: ManagementProjectionRecordId("future:1".to_owned()),
                record_kind: ManagementProjectionRecordKind::Custom("future_kind".to_owned()),
                file_ref: ManagementProjectionFileRef("nucleus/custom/future:1.json".to_owned()),
            },
            payload: ManagementProjectionPayload::Unsupported {
                payload_kind: "future_kind".to_owned(),
                retained_payload: "{\"field\":\"value\"}".to_owned(),
            },
        };

        let bytes = encode_management_projection_file_document(&document).expect("encode");
        let decoded = decode_management_projection_file_document(&bytes).expect("decode");

        assert_eq!(decoded, document);
        assert!(matches!(
            decoded.payload,
            ManagementProjectionPayload::Unsupported {
                payload_kind,
                retained_payload,
            } if payload_kind == "future_kind" && retained_payload.contains("field")
        ));
    }

    #[test]
    fn management_projection_file_codec_excludes_runtime_secret_and_layout_state() {
        let task = TaskStorageRecord {
            task_id: "task:safe".to_owned(),
            project_id: "project:nucleus".to_owned(),
            title: "Safe projection".to_owned(),
            description: Some("Only shared task intent is exported.".to_owned()),
            acceptance_criteria: Vec::new(),
            importance: TaskStorageImportance::Normal,
            action_type: TaskStorageActionType::Check,
            activity: TaskStorageActivityState::Ready,
            assignment_intent: Some("agent:steward".to_owned()),
            agent_ready: false,
            required_context_refs: Vec::new(),
            allowed_actions: vec![TaskStorageActionType::Check],
            stop_conditions: Vec::new(),
            validation_commands: vec!["effigy qa".to_owned()],
        };
        let entry = export_project_task_projection(&[], &[task])
            .entries
            .into_iter()
            .next()
            .expect("task entry");
        let document = projection_file_document_from_entry(entry);
        let bytes = encode_management_projection_file_document(&document).expect("encode");
        let toml = String::from_utf8(bytes).expect("toml");

        for forbidden in [
            "raw_stdout",
            "raw_stderr",
            "terminal_stream",
            "provider_auth",
            "provider_native_transcript",
            "live_runtime_event_stream",
            "browser_state",
            "client_layout",
            "global_display_window_surface",
            "per_project_panel",
            "secret",
            "local_cache",
        ] {
            assert!(!toml.contains(forbidden), "projection leaked {forbidden}");
        }
    }

    #[test]
    fn management_projection_validation_preserves_invalid_and_unsupported_records() {
        let invalid = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion::current(),
            record_id: ManagementProjectionRecordId(String::new()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef("outside/task.toml".to_owned()),
        };
        let unsupported = ManagementProjectionEnvelope {
            schema_version: ManagementProjectionSchemaVersion("future".to_owned()),
            record_id: ManagementProjectionRecordId("task:future".to_owned()),
            record_kind: ManagementProjectionRecordKind::Task,
            file_ref: ManagementProjectionFileRef::task("task:future"),
        };

        let invalid_report = validate_projection_envelope(
            &invalid,
            &[ManagementProjectionExcludedStateMarker::PerProjectPanelLayout],
        );
        let unsupported_report = validate_projection_envelope(&unsupported, &[]);

        assert_eq!(
            invalid_report.status,
            ManagementProjectionValidationStatus::Invalid
        );
        assert_eq!(
            unsupported_report.status,
            ManagementProjectionValidationStatus::UnsupportedSchema
        );
        assert!(invalid_report.issues.iter().any(|issue| {
            issue.kind == ManagementProjectionValidationIssueKind::ExcludedStatePresent
        }));
        assert_eq!(unsupported_report.record_id, Some(unsupported.record_id));
    }

    #[test]
    fn management_projection_conflict_reports_separate_schema_and_semantic_conflicts() {
        let schema = ManagementProjectionConflictReport {
            conflict_id: "conflict:schema:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:broken"),
            local_record_ref: None,
            incoming_record_ref: Some(ManagementProjectionRecordId("task:broken".to_owned())),
            class: ManagementProjectionConflictClass::Schema(
                ManagementProjectionSchemaConflictKind::InvalidRecordShape,
            ),
            summary: "invalid task record shape".to_owned(),
        };
        let semantic = ManagementProjectionConflictReport {
            conflict_id: "conflict:semantic:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:meaning"),
            local_record_ref: Some(ManagementProjectionRecordId("task:meaning".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:meaning".to_owned())),
            class: ManagementProjectionConflictClass::Semantic(
                ManagementProjectionSemanticConflictKind::AcceptanceCriteriaRewrite,
            ),
            summary: "acceptance criteria changed meaning".to_owned(),
        };
        let unsupported = ManagementProjectionConflictReport {
            conflict_id: "conflict:unsupported:1".to_owned(),
            file_ref: ManagementProjectionFileRef("nucleus/custom/future.toml".to_owned()),
            local_record_ref: None,
            incoming_record_ref: Some(ManagementProjectionRecordId("future:1".to_owned())),
            class: ManagementProjectionConflictClass::Unsupported(
                ManagementProjectionUnsupportedConflictKind::UnsupportedSchemaPreserved,
            ),
            summary: "unsupported schema preserved for later migration".to_owned(),
        };
        let scm = ManagementProjectionConflictReport {
            conflict_id: "conflict:scm:1".to_owned(),
            file_ref: ManagementProjectionFileRef::task("task:changed"),
            local_record_ref: Some(ManagementProjectionRecordId("task:changed".to_owned())),
            incoming_record_ref: Some(ManagementProjectionRecordId("task:changed".to_owned())),
            class: ManagementProjectionConflictClass::Scm(
                ManagementProjectionScmConflictKind::FileChangedDuringImport,
            ),
            summary: "projection file changed while import was staged".to_owned(),
        };
        let reports = vec![schema, semantic, unsupported, scm];
        let replayed = reports.clone();
        let json = serde_json::to_string(&reports).expect("conflict json");

        assert_eq!(reports, replayed);
        assert!(json.contains("schema"));
        assert!(json.contains("semantic"));
        assert!(json.contains("unsupported"));
        assert!(json.contains("scm"));
        for forbidden in ["raw_stdout", "terminal_stream", "provider_auth", "secret"] {
            assert!(!json.contains(forbidden), "conflict leaked {forbidden}");
        }
    }
}
