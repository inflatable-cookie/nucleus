//! Stopped-by-default Convergence-like publication preflight records.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationAdmissionRecord, ConvergencePublicationAdmissionSet,
    ConvergencePublicationAdmissionStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationPreflightInput {
    pub admissions: ConvergencePublicationAdmissionSet,
    pub operator_confirmed: bool,
    pub destination_ready: bool,
    pub publication_review_ready: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationPreflightSet {
    pub preflight_set_id: String,
    pub preflights: Vec<ConvergencePublicationPreflightRecord>,
    pub skipped_admission_ids: Vec<String>,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationPreflightRecord {
    pub preflight_id: String,
    pub admission_id: String,
    pub persisted_projection_id: String,
    pub projection_id: String,
    pub task_ids: Vec<String>,
    pub repo_ids: Vec<String>,
    pub operator_refs: Vec<String>,
    pub snapshot_stage_refs: Vec<String>,
    pub publish_stage_refs: Vec<String>,
    pub publication_review_stage_refs: Vec<String>,
    pub operator_confirmed: bool,
    pub destination_ready: bool,
    pub publication_review_ready: bool,
    pub status: ConvergencePublicationPreflightStatus,
    pub blockers: Vec<ConvergencePublicationPreflightBlocker>,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationPreflightStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationPreflightBlocker {
    AdmissionNotAdmitted,
    OperatorConfirmationMissing,
    DestinationNotReady,
    PublicationReviewNotReady,
}

pub fn convergence_publication_preflight(
    input: ConvergencePublicationPreflightInput,
) -> ConvergencePublicationPreflightSet {
    let flags = ConvergencePublicationPreflightFlags {
        operator_confirmed: input.operator_confirmed,
        destination_ready: input.destination_ready,
        publication_review_ready: input.publication_review_ready,
    };
    let mut preflights = input
        .admissions
        .admissions
        .into_iter()
        .map(|admission| preflight_record(&flags, admission))
        .collect::<Vec<_>>();
    preflights.sort_by(|left, right| left.preflight_id.cmp(&right.preflight_id));

    ConvergencePublicationPreflightSet {
        preflight_set_id: "convergence-publication-preflight".to_owned(),
        skipped_admission_ids: preflights
            .iter()
            .filter(|preflight| preflight.status != ConvergencePublicationPreflightStatus::Ready)
            .map(|preflight| preflight.admission_id.clone())
            .collect(),
        preflights,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn preflight_record(
    flags: &ConvergencePublicationPreflightFlags,
    admission: ConvergencePublicationAdmissionRecord,
) -> ConvergencePublicationPreflightRecord {
    let blockers = blockers(flags, &admission);
    let status = if blockers.is_empty() {
        ConvergencePublicationPreflightStatus::Ready
    } else {
        ConvergencePublicationPreflightStatus::Blocked
    };

    ConvergencePublicationPreflightRecord {
        preflight_id: format!(
            "convergence-publication-preflight:{}",
            admission.admission_id
        ),
        admission_id: admission.admission_id,
        persisted_projection_id: admission.persisted_projection_id,
        projection_id: admission.projection_id,
        task_ids: admission.task_ids,
        repo_ids: admission.repo_ids,
        operator_refs: admission.operator_refs,
        snapshot_stage_refs: admission.snapshot_stage_refs,
        publish_stage_refs: admission.publish_stage_refs,
        publication_review_stage_refs: admission.publication_review_stage_refs,
        operator_confirmed: flags.operator_confirmed,
        destination_ready: flags.destination_ready,
        publication_review_ready: flags.publication_review_ready,
        status,
        blockers,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    flags: &ConvergencePublicationPreflightFlags,
    admission: &ConvergencePublicationAdmissionRecord,
) -> Vec<ConvergencePublicationPreflightBlocker> {
    let mut blockers = Vec::new();
    if admission.status != ConvergencePublicationAdmissionStatus::Admitted {
        blockers.push(ConvergencePublicationPreflightBlocker::AdmissionNotAdmitted);
    }
    if !flags.operator_confirmed {
        blockers.push(ConvergencePublicationPreflightBlocker::OperatorConfirmationMissing);
    }
    if !flags.destination_ready {
        blockers.push(ConvergencePublicationPreflightBlocker::DestinationNotReady);
    }
    if !flags.publication_review_ready {
        blockers.push(ConvergencePublicationPreflightBlocker::PublicationReviewNotReady);
    }
    blockers
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ConvergencePublicationPreflightFlags {
    operator_confirmed: bool,
    destination_ready: bool,
    publication_review_ready: bool,
}

#[cfg(test)]
#[path = "provider_convergence_publication_preflight/tests.rs"]
mod tests;
