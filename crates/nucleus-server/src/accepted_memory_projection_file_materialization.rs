//! Scoped accepted-memory projection file materialization.
//!
//! This module writes admitted sanitized memory payloads under
//! `nucleus/memory/`. It does not call SCM/forge providers, import/apply
//! projected files, run embeddings, sync provider memory, mutate tasks, or
//! perform UI effects.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::accepted_memory_projection_payload::{
    encode_accepted_memory_projection_payload, AcceptedMemoryProjectionPayload,
};
use crate::accepted_memory_projection_write_admission::{
    AcceptedMemoryProjectionWriteAdmissionRecord, AcceptedMemoryProjectionWriteAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionMaterializationInput {
    pub admission: AcceptedMemoryProjectionWriteAdmissionRecord,
    pub payload: AcceptedMemoryProjectionPayload,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionMaterializationReport {
    pub outcomes: Vec<AcceptedMemoryProjectionMaterializationOutcome>,
    pub counts: AcceptedMemoryProjectionMaterializationCounts,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionMaterializationOutcome {
    pub memory_id: String,
    pub file_ref: Option<String>,
    pub status: AcceptedMemoryProjectionMaterializationStatus,
    pub blockers: Vec<AcceptedMemoryProjectionMaterializationBlocker>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionMaterializationStatus {
    Materialized,
    Skipped,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionMaterializationBlocker {
    AdmissionNotAdmitted,
    MissingFileRef,
    UnsafePath { reason: String },
    PayloadMemoryMismatch,
    EncodeFailed { reason: String },
    WriteFailed { reason: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionMaterializationCounts {
    pub records: usize,
    pub materialized_files: usize,
    pub skipped_records: usize,
    pub failed_records: usize,
    pub blocked_records: usize,
    pub unsafe_path_count: usize,
    pub encode_failure_count: usize,
    pub write_failure_count: usize,
}

pub fn materialize_accepted_memory_projection_files(
    project_management_root: &Path,
    inputs: impl IntoIterator<Item = AcceptedMemoryProjectionMaterializationInput>,
) -> AcceptedMemoryProjectionMaterializationReport {
    let outcomes: Vec<_> = inputs
        .into_iter()
        .map(|input| materialize_one(project_management_root, input))
        .collect();
    let counts = AcceptedMemoryProjectionMaterializationCounts::from_outcomes(&outcomes);

    AcceptedMemoryProjectionMaterializationReport {
        projection_write_performed: counts.materialized_files > 0,
        outcomes,
        counts,
        scm_effect_performed: false,
        import_or_apply_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

impl AcceptedMemoryProjectionMaterializationCounts {
    fn from_outcomes(outcomes: &[AcceptedMemoryProjectionMaterializationOutcome]) -> Self {
        let mut counts = Self {
            records: outcomes.len(),
            materialized_files: 0,
            skipped_records: 0,
            failed_records: 0,
            blocked_records: 0,
            unsafe_path_count: 0,
            encode_failure_count: 0,
            write_failure_count: 0,
        };

        for outcome in outcomes {
            match outcome.status {
                AcceptedMemoryProjectionMaterializationStatus::Materialized => {
                    counts.materialized_files += 1;
                }
                AcceptedMemoryProjectionMaterializationStatus::Skipped => {
                    counts.skipped_records += 1;
                }
                AcceptedMemoryProjectionMaterializationStatus::Failed => {
                    counts.failed_records += 1;
                }
            }

            if !outcome.blockers.is_empty() {
                counts.blocked_records += 1;
            }

            for blocker in &outcome.blockers {
                match blocker {
                    AcceptedMemoryProjectionMaterializationBlocker::UnsafePath { .. } => {
                        counts.unsafe_path_count += 1;
                    }
                    AcceptedMemoryProjectionMaterializationBlocker::EncodeFailed { .. } => {
                        counts.encode_failure_count += 1;
                    }
                    AcceptedMemoryProjectionMaterializationBlocker::WriteFailed { .. } => {
                        counts.write_failure_count += 1;
                    }
                    AcceptedMemoryProjectionMaterializationBlocker::AdmissionNotAdmitted
                    | AcceptedMemoryProjectionMaterializationBlocker::MissingFileRef
                    | AcceptedMemoryProjectionMaterializationBlocker::PayloadMemoryMismatch => {}
                }
            }
        }

        counts
    }
}

fn materialize_one(
    project_management_root: &Path,
    input: AcceptedMemoryProjectionMaterializationInput,
) -> AcceptedMemoryProjectionMaterializationOutcome {
    let mut blockers = materialization_blockers(&input);
    let file_ref = input.admission.file_ref.clone();

    let Some(target_path) = file_ref
        .as_deref()
        .and_then(|file_ref| safe_projection_path(project_management_root, file_ref).ok())
    else {
        return AcceptedMemoryProjectionMaterializationOutcome {
            memory_id: input.admission.memory_id,
            file_ref,
            status: AcceptedMemoryProjectionMaterializationStatus::Skipped,
            blockers,
        };
    };

    if !blockers.is_empty() {
        return AcceptedMemoryProjectionMaterializationOutcome {
            memory_id: input.admission.memory_id,
            file_ref,
            status: AcceptedMemoryProjectionMaterializationStatus::Skipped,
            blockers,
        };
    }

    let bytes = match encode_accepted_memory_projection_payload(&input.payload) {
        Ok(bytes) => bytes,
        Err(error) => {
            blockers.push(
                AcceptedMemoryProjectionMaterializationBlocker::EncodeFailed {
                    reason: error.reason,
                },
            );
            return AcceptedMemoryProjectionMaterializationOutcome {
                memory_id: input.admission.memory_id,
                file_ref,
                status: AcceptedMemoryProjectionMaterializationStatus::Failed,
                blockers,
            };
        }
    };

    if let Some(parent) = target_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            blockers.push(
                AcceptedMemoryProjectionMaterializationBlocker::WriteFailed {
                    reason: error.to_string(),
                },
            );
            return AcceptedMemoryProjectionMaterializationOutcome {
                memory_id: input.admission.memory_id,
                file_ref,
                status: AcceptedMemoryProjectionMaterializationStatus::Failed,
                blockers,
            };
        }
    }

    match fs::write(&target_path, bytes) {
        Ok(()) => AcceptedMemoryProjectionMaterializationOutcome {
            memory_id: input.admission.memory_id,
            file_ref,
            status: AcceptedMemoryProjectionMaterializationStatus::Materialized,
            blockers,
        },
        Err(error) => {
            blockers.push(
                AcceptedMemoryProjectionMaterializationBlocker::WriteFailed {
                    reason: error.to_string(),
                },
            );
            AcceptedMemoryProjectionMaterializationOutcome {
                memory_id: input.admission.memory_id,
                file_ref,
                status: AcceptedMemoryProjectionMaterializationStatus::Failed,
                blockers,
            }
        }
    }
}

fn materialization_blockers(
    input: &AcceptedMemoryProjectionMaterializationInput,
) -> Vec<AcceptedMemoryProjectionMaterializationBlocker> {
    let mut blockers = Vec::new();

    if input.admission.status != AcceptedMemoryProjectionWriteAdmissionStatus::Admitted {
        blockers.push(AcceptedMemoryProjectionMaterializationBlocker::AdmissionNotAdmitted);
    }

    if input.admission.file_ref.is_none() {
        blockers.push(AcceptedMemoryProjectionMaterializationBlocker::MissingFileRef);
    }

    if input.admission.memory_id != input.payload.memory_id {
        blockers.push(AcceptedMemoryProjectionMaterializationBlocker::PayloadMemoryMismatch);
    }

    if let Some(file_ref) = &input.admission.file_ref {
        if let Err(reason) = validate_file_ref(file_ref) {
            blockers.push(AcceptedMemoryProjectionMaterializationBlocker::UnsafePath { reason });
        }
    }

    blockers
}

fn safe_projection_path(project_management_root: &Path, file_ref: &str) -> Result<PathBuf, String> {
    validate_file_ref(file_ref)?;
    Ok(project_management_root.join(file_ref))
}

fn validate_file_ref(file_ref: &str) -> Result<(), String> {
    let path = Path::new(file_ref);
    if path.is_absolute() {
        return Err("file ref must be relative".to_owned());
    }

    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(first)), Some(Component::Normal(second)))
            if first == "nucleus" && second == "memory" => {}
        _ => return Err("file ref must be under nucleus/memory".to_owned()),
    }

    if !file_ref.ends_with(".toml") {
        return Err("file ref must end in .toml".to_owned());
    }

    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("file ref must not escape projection root".to_owned());
    }

    Ok(())
}
