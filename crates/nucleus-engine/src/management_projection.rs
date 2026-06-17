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
#[serde(tag = "kind", content = "record", rename_all = "snake_case")]
pub enum ManagementProjectionPayload {
    Project(ProjectStorageRecord),
    Task(TaskStorageRecord),
    Index { title: String },
    ArtifactIndex { title: String },
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
        let json = serde_json::to_string(&vec![schema, semantic]).expect("conflict json");

        assert!(json.contains("schema"));
        assert!(json.contains("semantic"));
        assert!(!json.contains("pull_request"));
        assert!(!json.contains("branch"));
        assert!(!json.contains("commit"));
    }
}
