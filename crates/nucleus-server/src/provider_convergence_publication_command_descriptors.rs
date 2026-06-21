//! Command descriptors for Convergence-like publication preflight records.

use serde::{Deserialize, Serialize};

use crate::{
    ConvergencePublicationPreflightRecord, ConvergencePublicationPreflightSet,
    ConvergencePublicationPreflightStatus,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConvergencePublicationCommandDescriptorsInput {
    pub preflights: ConvergencePublicationPreflightSet,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationCommandDescriptorSet {
    pub descriptor_set_id: String,
    pub descriptors: Vec<ConvergencePublicationCommandDescriptorRecord>,
    pub skipped_preflight_ids: Vec<String>,
    pub executable_argv_built: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ConvergencePublicationCommandDescriptorRecord {
    pub descriptor_id: String,
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
    pub snapshot_descriptor_ref: Option<String>,
    pub publish_descriptor_ref: Option<String>,
    pub publication_review_descriptor_ref: Option<String>,
    pub status: ConvergencePublicationCommandDescriptorStatus,
    pub blockers: Vec<ConvergencePublicationCommandDescriptorBlocker>,
    pub executable_argv_built: bool,
    pub snapshot_creation_permitted: bool,
    pub publish_permitted: bool,
    pub publication_review_permitted: bool,
    pub provider_write_permitted: bool,
    pub task_mutation_permitted: bool,
    pub raw_output_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationCommandDescriptorStatus {
    Ready,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConvergencePublicationCommandDescriptorBlocker {
    PreflightNotReady,
    MissingSnapshotStage,
    MissingPublishStage,
    MissingPublicationReviewStage,
}

pub fn convergence_publication_command_descriptors(
    input: ConvergencePublicationCommandDescriptorsInput,
) -> ConvergencePublicationCommandDescriptorSet {
    let mut descriptors = input
        .preflights
        .preflights
        .into_iter()
        .map(descriptor_record)
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| left.descriptor_id.cmp(&right.descriptor_id));

    ConvergencePublicationCommandDescriptorSet {
        descriptor_set_id: "convergence-publication-command-descriptors".to_owned(),
        skipped_preflight_ids: descriptors
            .iter()
            .filter(|descriptor| {
                descriptor.status != ConvergencePublicationCommandDescriptorStatus::Ready
            })
            .map(|descriptor| descriptor.preflight_id.clone())
            .collect(),
        descriptors,
        executable_argv_built: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn descriptor_record(
    preflight: ConvergencePublicationPreflightRecord,
) -> ConvergencePublicationCommandDescriptorRecord {
    let blockers = blockers(&preflight);
    let status = if blockers.is_empty() {
        ConvergencePublicationCommandDescriptorStatus::Ready
    } else {
        ConvergencePublicationCommandDescriptorStatus::Blocked
    };

    ConvergencePublicationCommandDescriptorRecord {
        descriptor_id: format!("convergence-publication-command:{}", preflight.preflight_id),
        preflight_id: preflight.preflight_id,
        admission_id: preflight.admission_id,
        persisted_projection_id: preflight.persisted_projection_id,
        projection_id: preflight.projection_id,
        task_ids: preflight.task_ids,
        repo_ids: preflight.repo_ids,
        operator_refs: preflight.operator_refs,
        snapshot_descriptor_ref: single_descriptor_ref(
            "convergence-snapshot-command",
            &preflight.snapshot_stage_refs,
        ),
        publish_descriptor_ref: single_descriptor_ref(
            "convergence-publish-command",
            &preflight.publish_stage_refs,
        ),
        publication_review_descriptor_ref: single_descriptor_ref(
            "convergence-publication-review-command",
            &preflight.publication_review_stage_refs,
        ),
        snapshot_stage_refs: preflight.snapshot_stage_refs,
        publish_stage_refs: preflight.publish_stage_refs,
        publication_review_stage_refs: preflight.publication_review_stage_refs,
        status,
        blockers,
        executable_argv_built: false,
        snapshot_creation_permitted: false,
        publish_permitted: false,
        publication_review_permitted: false,
        provider_write_permitted: false,
        task_mutation_permitted: false,
        raw_output_retained: false,
    }
}

fn blockers(
    preflight: &ConvergencePublicationPreflightRecord,
) -> Vec<ConvergencePublicationCommandDescriptorBlocker> {
    let mut blockers = Vec::new();
    if preflight.status != ConvergencePublicationPreflightStatus::Ready {
        blockers.push(ConvergencePublicationCommandDescriptorBlocker::PreflightNotReady);
    }
    if preflight.snapshot_stage_refs.is_empty() {
        blockers.push(ConvergencePublicationCommandDescriptorBlocker::MissingSnapshotStage);
    }
    if preflight.publish_stage_refs.is_empty() {
        blockers.push(ConvergencePublicationCommandDescriptorBlocker::MissingPublishStage);
    }
    if preflight.publication_review_stage_refs.is_empty() {
        blockers
            .push(ConvergencePublicationCommandDescriptorBlocker::MissingPublicationReviewStage);
    }
    blockers
}

fn single_descriptor_ref(prefix: &str, stage_refs: &[String]) -> Option<String> {
    stage_refs
        .first()
        .map(|stage_ref| format!("{prefix}:{stage_ref}"))
}

#[cfg(test)]
#[path = "provider_convergence_publication_command_descriptors/tests.rs"]
mod tests;
