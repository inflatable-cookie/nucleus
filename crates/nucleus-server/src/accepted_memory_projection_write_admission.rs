//! Accepted-memory projection write admission.
//!
//! Admission turns stopped export-plan entries into write intents for a later
//! scoped writer. It does not write files, call SCM/forge providers, run
//! embeddings, sync provider memory, mutate tasks, or expose raw memory bodies.

use nucleus_projects::ProjectId;

use crate::accepted_memory_projection_export_plan::{
    accepted_memory_projection_file_ref, accepted_memory_projection_plan_ref,
    AcceptedMemoryProjectionExportBlocker, AcceptedMemoryProjectionExportEntry,
    AcceptedMemoryProjectionExportPlan, AcceptedMemoryProjectionExportStatus,
};
use crate::accepted_memory_projection_policy::{
    AcceptedMemoryProjectionPolicyBlocker, AcceptedMemoryProjectionPolicyStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteAdmissionSet {
    pub project_id: ProjectId,
    pub admissions: Vec<AcceptedMemoryProjectionWriteAdmissionRecord>,
    pub counts: AcceptedMemoryProjectionWriteAdmissionCounts,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteAdmissionRecord {
    pub memory_id: String,
    pub plan_ref: String,
    pub file_ref: Option<String>,
    pub status: AcceptedMemoryProjectionWriteAdmissionStatus,
    pub policy_status: AcceptedMemoryProjectionPolicyStatus,
    pub export_status: AcceptedMemoryProjectionExportStatus,
    pub policy_blockers: Vec<AcceptedMemoryProjectionPolicyBlocker>,
    pub export_blockers: Vec<AcceptedMemoryProjectionExportBlocker>,
    pub admission_blockers: Vec<AcceptedMemoryProjectionWriteAdmissionBlocker>,
    pub projection_write_performed: bool,
    pub scm_effect_performed: bool,
    pub import_or_apply_performed: bool,
    pub embedding_available: bool,
    pub provider_sync_available: bool,
    pub task_mutation_performed: bool,
    pub ui_effect_performed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionWriteAdmissionStatus {
    Admitted,
    Blocked,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AcceptedMemoryProjectionWriteAdmissionBlocker {
    PolicyNotProjectable {
        status: AcceptedMemoryProjectionPolicyStatus,
    },
    ExportNotStopped {
        status: AcceptedMemoryProjectionExportStatus,
    },
    ExportBlockersPresent,
    MissingFileRef,
    UnsafeFileRef {
        reason: String,
    },
    PlanRefMismatch {
        expected: String,
    },
    FileRefMismatch {
        expected: String,
    },
    PriorProjectionWriteObserved,
    PriorScmEffectObserved,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AcceptedMemoryProjectionWriteAdmissionCounts {
    pub entries: usize,
    pub admitted_writes: usize,
    pub blocked_writes: usize,
    pub missing_file_refs: usize,
    pub unsafe_file_refs: usize,
    pub plan_ref_mismatches: usize,
    pub file_ref_mismatches: usize,
    pub policy_blockers: usize,
    pub export_blockers: usize,
    pub admission_blockers: usize,
}

pub fn accepted_memory_projection_write_admissions(
    plan: AcceptedMemoryProjectionExportPlan,
) -> AcceptedMemoryProjectionWriteAdmissionSet {
    let admissions: Vec<_> = plan
        .entries
        .into_iter()
        .map(accepted_memory_projection_write_admission)
        .collect();
    let counts = AcceptedMemoryProjectionWriteAdmissionCounts::from_admissions(&admissions);

    AcceptedMemoryProjectionWriteAdmissionSet {
        project_id: plan.project_id,
        admissions,
        counts,
        projection_write_performed: false,
        scm_effect_performed: false,
        import_or_apply_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

pub fn accepted_memory_projection_write_admission(
    entry: AcceptedMemoryProjectionExportEntry,
) -> AcceptedMemoryProjectionWriteAdmissionRecord {
    let mut blockers = admission_blockers(&entry);

    let status = if blockers.is_empty() {
        AcceptedMemoryProjectionWriteAdmissionStatus::Admitted
    } else {
        AcceptedMemoryProjectionWriteAdmissionStatus::Blocked
    };

    AcceptedMemoryProjectionWriteAdmissionRecord {
        memory_id: entry.memory_id,
        plan_ref: entry.plan_ref,
        file_ref: entry.file_ref,
        status,
        policy_status: entry.policy_status,
        export_status: entry.status,
        policy_blockers: entry.policy_blockers,
        export_blockers: entry.export_blockers,
        admission_blockers: std::mem::take(&mut blockers),
        projection_write_performed: false,
        scm_effect_performed: false,
        import_or_apply_performed: false,
        embedding_available: false,
        provider_sync_available: false,
        task_mutation_performed: false,
        ui_effect_performed: false,
    }
}

impl AcceptedMemoryProjectionWriteAdmissionCounts {
    fn from_admissions(admissions: &[AcceptedMemoryProjectionWriteAdmissionRecord]) -> Self {
        let mut counts = Self {
            entries: admissions.len(),
            admitted_writes: 0,
            blocked_writes: 0,
            missing_file_refs: 0,
            unsafe_file_refs: 0,
            plan_ref_mismatches: 0,
            file_ref_mismatches: 0,
            policy_blockers: 0,
            export_blockers: 0,
            admission_blockers: 0,
        };

        for admission in admissions {
            match admission.status {
                AcceptedMemoryProjectionWriteAdmissionStatus::Admitted => {
                    counts.admitted_writes += 1;
                }
                AcceptedMemoryProjectionWriteAdmissionStatus::Blocked => {
                    counts.blocked_writes += 1;
                }
            }
            counts.policy_blockers += admission.policy_blockers.len();
            counts.export_blockers += admission.export_blockers.len();
            counts.admission_blockers += admission.admission_blockers.len();

            for blocker in &admission.admission_blockers {
                match blocker {
                    AcceptedMemoryProjectionWriteAdmissionBlocker::MissingFileRef => {
                        counts.missing_file_refs += 1;
                    }
                    AcceptedMemoryProjectionWriteAdmissionBlocker::UnsafeFileRef { .. } => {
                        counts.unsafe_file_refs += 1;
                    }
                    AcceptedMemoryProjectionWriteAdmissionBlocker::PlanRefMismatch { .. } => {
                        counts.plan_ref_mismatches += 1;
                    }
                    AcceptedMemoryProjectionWriteAdmissionBlocker::FileRefMismatch { .. } => {
                        counts.file_ref_mismatches += 1;
                    }
                    AcceptedMemoryProjectionWriteAdmissionBlocker::PolicyNotProjectable {
                        ..
                    }
                    | AcceptedMemoryProjectionWriteAdmissionBlocker::ExportNotStopped { .. }
                    | AcceptedMemoryProjectionWriteAdmissionBlocker::ExportBlockersPresent
                    | AcceptedMemoryProjectionWriteAdmissionBlocker::PriorProjectionWriteObserved
                    | AcceptedMemoryProjectionWriteAdmissionBlocker::PriorScmEffectObserved => {}
                }
            }
        }

        counts
    }
}

fn admission_blockers(
    entry: &AcceptedMemoryProjectionExportEntry,
) -> Vec<AcceptedMemoryProjectionWriteAdmissionBlocker> {
    let mut blockers = Vec::new();

    if entry.policy_status != AcceptedMemoryProjectionPolicyStatus::Projectable {
        blockers.push(
            AcceptedMemoryProjectionWriteAdmissionBlocker::PolicyNotProjectable {
                status: entry.policy_status.clone(),
            },
        );
    }

    if entry.status != AcceptedMemoryProjectionExportStatus::Stopped {
        blockers.push(
            AcceptedMemoryProjectionWriteAdmissionBlocker::ExportNotStopped {
                status: entry.status.clone(),
            },
        );
    }

    if !entry.export_blockers.is_empty() {
        blockers.push(AcceptedMemoryProjectionWriteAdmissionBlocker::ExportBlockersPresent);
    }

    if entry.projection_write_performed {
        blockers.push(AcceptedMemoryProjectionWriteAdmissionBlocker::PriorProjectionWriteObserved);
    }

    if entry.scm_effect_performed {
        blockers.push(AcceptedMemoryProjectionWriteAdmissionBlocker::PriorScmEffectObserved);
    }

    let expected_plan_ref = accepted_memory_projection_plan_ref(&entry.memory_id);
    if entry.plan_ref != expected_plan_ref {
        blockers.push(
            AcceptedMemoryProjectionWriteAdmissionBlocker::PlanRefMismatch {
                expected: expected_plan_ref,
            },
        );
    }

    match expected_file_ref(&entry.memory_id) {
        Ok(expected) => match &entry.file_ref {
            Some(file_ref) if file_ref == &expected => {}
            Some(file_ref) if !file_ref_is_safe(file_ref) => {
                blockers.push(
                    AcceptedMemoryProjectionWriteAdmissionBlocker::UnsafeFileRef {
                        reason: "file ref is outside nucleus/memory projection root".to_owned(),
                    },
                );
            }
            Some(_) => {
                blockers.push(
                    AcceptedMemoryProjectionWriteAdmissionBlocker::FileRefMismatch { expected },
                );
            }
            None => blockers.push(AcceptedMemoryProjectionWriteAdmissionBlocker::MissingFileRef),
        },
        Err(reason) => {
            blockers.push(AcceptedMemoryProjectionWriteAdmissionBlocker::UnsafeFileRef { reason });
        }
    }

    blockers
}

fn expected_file_ref(memory_id: &str) -> Result<String, String> {
    accepted_memory_projection_file_ref(memory_id)
}

fn file_ref_is_safe(file_ref: &str) -> bool {
    file_ref.starts_with("nucleus/memory/")
        && file_ref.ends_with(".toml")
        && !file_ref.contains("..")
        && !file_ref.contains('\\')
}
