use super::helpers::unique_sorted;
use super::store::OUTCOME_PREFIX;
use super::types::{
    ForgePullRequestRunnerOutcomePersistenceBlocker, ForgePullRequestRunnerOutcomePersistenceInput,
    ForgePullRequestRunnerOutcomePersistenceRecord, ForgePullRequestRunnerOutcomePersistenceStatus,
    ForgePullRequestRunnerOutcomeStatus,
};
use crate::provider_no_effects::ForgeScmNoEffects;
use crate::{
    ForgePullRequestRunnerRequestAdapterRecord, ForgePullRequestRunnerRequestAdapterStatus,
};

pub(super) fn outcome_record(
    input: &ForgePullRequestRunnerOutcomePersistenceInput,
    request: ForgePullRequestRunnerRequestAdapterRecord,
    persisted_outcome_id: String,
    duplicate_outcome_detected: bool,
    persistence_blockers: Vec<ForgePullRequestRunnerOutcomePersistenceBlocker>,
) -> ForgePullRequestRunnerOutcomePersistenceRecord {
    let persistence_status = if duplicate_outcome_detected {
        ForgePullRequestRunnerOutcomePersistenceStatus::DuplicateNoop
    } else if persistence_blockers.is_empty() {
        ForgePullRequestRunnerOutcomePersistenceStatus::Persisted
    } else {
        ForgePullRequestRunnerOutcomePersistenceStatus::Blocked
    };
    let outcome_status = outcome_status(
        input.requested_status.clone(),
        &request.status,
        duplicate_outcome_detected,
    );

    ForgePullRequestRunnerOutcomePersistenceRecord {
        persisted_outcome_id,
        request_adapter_id: request.request_adapter_id,
        authority_id: request.authority_id,
        preflight_id: request.preflight_id,
        admission_id: request.admission_id,
        pr_evidence_id: request.pr_evidence_id,
        pr_descriptor_id: request.pr_descriptor_id,
        push_preflight_id: request.push_preflight_id,
        request_id: request.request_id,
        upstream_authority_id: request.upstream_authority_id,
        git_plan_id: request.git_plan_id,
        task_id: request.task_id,
        repo_id: request.repo_id,
        operator_ref: request.operator_ref,
        operator_confirmation_ref: request.operator_confirmation_ref,
        remote_target: request.remote_target,
        forge_provider: request.forge_provider,
        base_branch: request.base_branch,
        head_branch: request.head_branch,
        title_source: request.title_source,
        body_source: request.body_source,
        request_status: request.status,
        request_blockers: request.blockers,
        outcome_status,
        persistence_status,
        persistence_blockers,
        duplicate_outcome_detected,
        inspected_ref_count: input.inspected_ref_count,
        evidence_refs: unique_sorted(input.evidence_refs.clone()),
        provider_request_prepared: request.provider_request_prepared,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn persisted_outcome_id(request_adapter_id: &str) -> String {
    format!("{OUTCOME_PREFIX}{request_adapter_id}")
}

fn outcome_status(
    requested: ForgePullRequestRunnerOutcomeStatus,
    request_status: &ForgePullRequestRunnerRequestAdapterStatus,
    duplicate: bool,
) -> ForgePullRequestRunnerOutcomeStatus {
    if duplicate {
        return ForgePullRequestRunnerOutcomeStatus::DuplicateNoop;
    }
    match request_status {
        ForgePullRequestRunnerRequestAdapterStatus::Ready => requested,
        ForgePullRequestRunnerRequestAdapterStatus::Blocked => {
            ForgePullRequestRunnerOutcomeStatus::Blocked
        }
        ForgePullRequestRunnerRequestAdapterStatus::RepairRequired => {
            ForgePullRequestRunnerOutcomeStatus::RepairRequired
        }
    }
}
