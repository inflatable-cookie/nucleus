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
