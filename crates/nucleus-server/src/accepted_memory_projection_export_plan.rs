//! Stopped accepted-memory projection export plans.
//!
//! Export plans derive deterministic refs for later projection work. They do
//! not write files, call SCM/forge providers, mutate state, run embeddings, or
//! expose raw memory bodies.

use nucleus_memory::{
    AcceptedMemoryStorageRecord, MemoryProposalStorageKind, ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION,
};
use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_policy::{
    accepted_memory_projection_policy_decision, AcceptedMemoryProjectionPolicyBlocker,
    AcceptedMemoryProjectionPolicyStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionExportPlan {
    pub project_id: ProjectId,
    pub entries: Vec<AcceptedMemoryProjectionExportEntry>,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionExportEntry {
    pub plan_ref: String,
    pub memory_id: String,
    pub status: AcceptedMemoryProjectionExportStatus,
    pub file_ref: Option<String>,
    pub policy_status: AcceptedMemoryProjectionPolicyStatus,
    pub policy_blockers: Vec<AcceptedMemoryProjectionPolicyBlocker>,
    pub export_blockers: Vec<AcceptedMemoryProjectionExportBlocker>,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionExportStatus {
    Stopped,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionExportBlocker {
    PolicyDenied,
    UnsupportedSchema { schema_version: u16 },
    UnsupportedMemoryKind { kind: String },
    UnsafePathRef { reason: String },
}

pub fn accepted_memory_projection_export_plan(
    project_id: ProjectId,
    records: impl IntoIterator<Item = AcceptedMemoryStorageRecord>,
) -> AcceptedMemoryProjectionExportPlan {
    let entries = records
        .into_iter()
        .map(|record| accepted_memory_projection_export_entry(&project_id, &record))
        .collect();

    AcceptedMemoryProjectionExportPlan {
        project_id,
        entries,
        projection_write_performed: false,
        scm_effect_performed: false,
    }
}

pub fn accepted_memory_projection_export_entry(
    project_id: &ProjectId,
    record: &AcceptedMemoryStorageRecord,
) -> AcceptedMemoryProjectionExportEntry {
    let policy = accepted_memory_projection_policy_decision(project_id, record);
    let mut export_blockers = export_blockers(record, &policy.status);
    let file_ref = if export_blockers.is_empty() {
        match accepted_memory_projection_file_ref(&record.memory_id) {
            Ok(file_ref) => Some(file_ref),
            Err(reason) => {
                export_blockers
                    .push(AcceptedMemoryProjectionExportBlocker::UnsafePathRef { reason });
                None
            }
        }
    } else {
        None
    };

    AcceptedMemoryProjectionExportEntry {
        plan_ref: accepted_memory_projection_plan_ref(&record.memory_id),
        memory_id: record.memory_id.clone(),
        status: if export_blockers.is_empty() {
            AcceptedMemoryProjectionExportStatus::Stopped
        } else {
            AcceptedMemoryProjectionExportStatus::Blocked
        },
        file_ref,
        policy_status: policy.status,
        policy_blockers: policy.blockers,
        export_blockers,
        projection_write_performed: false,
        scm_effect_performed: false,
    }
}

pub fn accepted_memory_projection_file_ref(memory_id: &str) -> Result<String, String> {
    if !memory_id_is_path_safe(memory_id) {
        return Err("memory id is not safe for nucleus/memory projection path".to_owned());
    }

    Ok(format!("nucleus/memory/{memory_id}.toml"))
}

pub fn accepted_memory_projection_plan_ref(memory_id: &str) -> String {
    format!("accepted-memory-export-plan:{memory_id}")
}

fn export_blockers(
    record: &AcceptedMemoryStorageRecord,
    policy_status: &AcceptedMemoryProjectionPolicyStatus,
) -> Vec<AcceptedMemoryProjectionExportBlocker> {
    let mut blockers = Vec::new();

    if !matches!(
        policy_status,
        AcceptedMemoryProjectionPolicyStatus::Projectable
    ) {
        blockers.push(AcceptedMemoryProjectionExportBlocker::PolicyDenied);
    }

    if record.schema_version != ACCEPTED_MEMORY_STORAGE_SCHEMA_VERSION {
        blockers.push(AcceptedMemoryProjectionExportBlocker::UnsupportedSchema {
            schema_version: record.schema_version,
        });
    }

    if let MemoryProposalStorageKind::Other { label } = &record.kind {
        blockers.push(
            AcceptedMemoryProjectionExportBlocker::UnsupportedMemoryKind {
                kind: label.clone(),
            },
        );
    }

    blockers
}

fn memory_id_is_path_safe(memory_id: &str) -> bool {
    !memory_id.trim().is_empty()
        && !memory_id.contains('/')
        && !memory_id.contains('\\')
        && !memory_id.contains("..")
}
