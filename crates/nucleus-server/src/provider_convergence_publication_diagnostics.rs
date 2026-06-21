//! Diagnostics for Convergence-like publication admission and preflight.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationAdmissionSet, ConvergencePublicationAdmissionStatus,
    ConvergencePublicationPreflightSet, ConvergencePublicationPreflightStatus,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationDiagnosticsRecord {
    pub diagnostics_id: String,
    pub admission_count: usize,
    pub admitted_count: usize,
    pub blocked_admission_count: usize,
    pub admission_blocker_count: usize,
    pub preflight_count: usize,
    pub ready_preflight_count: usize,
    pub blocked_preflight_count: usize,
    pub preflight_blocker_count: usize,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

pub fn convergence_publication_diagnostics(
    admissions: ConvergencePublicationAdmissionSet,
    preflights: ConvergencePublicationPreflightSet,
) -> ConvergencePublicationDiagnosticsRecord {
    ConvergencePublicationDiagnosticsRecord {
        diagnostics_id: "convergence-publication-diagnostics".to_owned(),
        admission_count: admissions.admissions.len(),
        admitted_count: admissions
            .admissions
            .iter()
            .filter(|admission| admission.status == ConvergencePublicationAdmissionStatus::Admitted)
            .count(),
        blocked_admission_count: admissions
            .admissions
            .iter()
            .filter(|admission| admission.status == ConvergencePublicationAdmissionStatus::Blocked)
            .count(),
        admission_blocker_count: admissions
            .admissions
            .iter()
            .map(|admission| admission.blockers.len())
            .sum(),
        preflight_count: preflights.preflights.len(),
        ready_preflight_count: preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == ConvergencePublicationPreflightStatus::Ready)
            .count(),
        blocked_preflight_count: preflights
            .preflights
            .iter()
            .filter(|preflight| preflight.status == ConvergencePublicationPreflightStatus::Blocked)
            .count(),
        preflight_blocker_count: preflights
            .preflights
            .iter()
            .map(|preflight| preflight.blockers.len())
            .sum(),
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

#[cfg(test)]
#[path = "provider_convergence_publication_diagnostics/tests.rs"]
mod tests;
