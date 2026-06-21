//! Read-only diagnostics for Convergence local snap admission records.

use serde::{Deserialize, Serialize};

use crate::{ConvergenceLocalSnapAdmissionSet, ConvergenceLocalSnapAdmissionStatus};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergenceLocalSnapAdmissionDiagnostics {
    pub diagnostics_id: String,
    pub record_count: usize,
    pub admitted_count: usize,
    pub duplicate_count: usize,
    pub blocked_count: usize,
    pub unsupported_count: usize,
    pub blocker_count: usize,
    pub local_snap_creation_admitted: bool,
    pub local_snap_creation_executed: bool,
    pub remote_effect_permitted: bool,
    pub object_upload_permitted: bool,
    pub publication_permitted: bool,
    pub lane_sync_permitted: bool,
    pub bundle_permitted: bool,
    pub approval_permitted: bool,
    pub promotion_permitted: bool,
    pub release_permitted: bool,
    pub resolution_publication_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_material_retained: bool,
}

pub fn convergence_local_snap_admission_diagnostics(
    admission: ConvergenceLocalSnapAdmissionSet,
) -> ConvergenceLocalSnapAdmissionDiagnostics {
    ConvergenceLocalSnapAdmissionDiagnostics {
        diagnostics_id: "convergence-local-snap-admission-diagnostics".to_owned(),
        record_count: admission.records.len(),
        admitted_count: count_status(&admission, ConvergenceLocalSnapAdmissionStatus::Admitted),
        duplicate_count: count_status(
            &admission,
            ConvergenceLocalSnapAdmissionStatus::DuplicateNoop,
        ),
        blocked_count: count_status(&admission, ConvergenceLocalSnapAdmissionStatus::Blocked),
        unsupported_count: count_status(
            &admission,
            ConvergenceLocalSnapAdmissionStatus::Unsupported,
        ),
        blocker_count: admission
            .records
            .iter()
            .map(|record| record.blockers.len())
            .sum(),
        local_snap_creation_admitted: admission.local_snap_creation_admitted,
        local_snap_creation_executed: false,
        remote_effect_permitted: false,
        object_upload_permitted: false,
        publication_permitted: false,
        lane_sync_permitted: false,
        bundle_permitted: false,
        approval_permitted: false,
        promotion_permitted: false,
        release_permitted: false,
        resolution_publication_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_material_retained: false,
    }
}

fn count_status(
    admission: &ConvergenceLocalSnapAdmissionSet,
    status: ConvergenceLocalSnapAdmissionStatus,
) -> usize {
    admission
        .records
        .iter()
        .filter(|record| record.status == status)
        .count()
}

#[cfg(test)]
#[path = "provider_convergence_local_snap_admission_diagnostics/tests.rs"]
mod tests;
