use crate::provider_no_effects::{ForgeScmNoEffects};
use super::super::*;
use crate::{
    ForgePullRequestProvider, ForgePullRequestRunnerRequestAdapterRecord,
    ForgePullRequestRunnerRequestAdapterSet, ForgePullRequestRunnerRequestAdapterStatus,
    ForgePullRequestTextSource,
};

pub(super) fn input(
    requests: ForgePullRequestRunnerRequestAdapterSet,
    requested_status: ForgePullRequestRunnerOutcomeStatus,
    forbidden: bool,
) -> ForgePullRequestRunnerOutcomePersistenceInput {
    ForgePullRequestRunnerOutcomePersistenceInput {
        requests,
        requested_status,
        inspected_ref_count: 4,
        evidence_refs: vec!["evidence:runner".to_owned()],
        existing_outcome_ids: Vec::new(),
        raw_stdout_present: forbidden,
        raw_stderr_present: forbidden,
        raw_title_present: forbidden,
        raw_body_present: forbidden,
        provider_payload_present: forbidden,
        raw_output_retention_requested: forbidden,
        pull_request_creation_requested: forbidden,
        forge_effect_requested: forbidden,
        provider_effect_requested: forbidden,
        callback_effect_requested: forbidden,
        interruption_effect_requested: forbidden,
        recovery_effect_requested: forbidden,
        task_mutation_requested: forbidden,
    }
}

pub(super) fn request_set(
    requests: Vec<ForgePullRequestRunnerRequestAdapterRecord>,
) -> ForgePullRequestRunnerRequestAdapterSet {
    ForgePullRequestRunnerRequestAdapterSet {
        request_set_id: "request-set:1".to_owned(),
        requests,
        skipped_authority_ids: Vec::new(),
        provider_request_prepared: true,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn request(
    id: &str,
    status: ForgePullRequestRunnerRequestAdapterStatus,
) -> ForgePullRequestRunnerRequestAdapterRecord {
    ForgePullRequestRunnerRequestAdapterRecord {
        request_adapter_id: format!("request:{id}"),
        authority_id: format!("authority:{id}"),
        preflight_id: format!("preflight:{id}"),
        admission_id: format!("admission:{id}"),
        pr_evidence_id: format!("pr-evidence:{id}"),
        pr_descriptor_id: format!("pr-descriptor:{id}"),
        push_preflight_id: format!("push-preflight:{id}"),
        request_id: format!("work-request:{id}"),
        upstream_authority_id: format!("upstream-authority:{id}"),
        git_plan_id: "git-plan:1".to_owned(),
        task_id: "task:1".to_owned(),
        repo_id: "repo:1".to_owned(),
        operator_ref: "operator:tom".to_owned(),
        operator_confirmation_ref: Some(format!("confirmation:{id}")),
        remote_target: None,
        forge_provider: Some(ForgePullRequestProvider::GitHub),
        base_branch: Some("main".to_owned()),
        head_branch: Some("feature/task".to_owned()),
        title_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        body_source: Some(ForgePullRequestTextSource::GeneratedFromEvidence),
        status: status.clone(),
        blockers: Vec::new(),
        provider_request_prepared: status == ForgePullRequestRunnerRequestAdapterStatus::Ready,
        shell_passthrough_used: false,
        shell_execution_performed: false,
        no_effects: ForgeScmNoEffects::none(),
    }
}

pub(super) fn persisted(
    id: &str,
    outcome_status: ForgePullRequestRunnerOutcomeStatus,
) -> ForgePullRequestRunnerOutcomePersistenceRecord {
    let request = request(id, ready());
    outcome_record(
        &input(request_set(vec![request.clone()]), outcome_status, false),
        request,
        format!("persisted:{id}"),
        false,
        Vec::new(),
    )
}

pub(super) fn ready() -> ForgePullRequestRunnerRequestAdapterStatus {
    ForgePullRequestRunnerRequestAdapterStatus::Ready
}

pub(super) fn blocked() -> ForgePullRequestRunnerRequestAdapterStatus {
    ForgePullRequestRunnerRequestAdapterStatus::Blocked
}

pub(super) fn repair_required() -> ForgePullRequestRunnerRequestAdapterStatus {
    ForgePullRequestRunnerRequestAdapterStatus::RepairRequired
}

pub(super) fn completed() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::Completed
}

pub(super) fn failed() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::Failed
}

pub(super) fn failed_status() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::Failed
}

pub(super) fn blocked_status() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::Blocked
}

pub(super) fn repair_status() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::RepairRequired
}

pub(super) fn duplicate_status() -> ForgePullRequestRunnerOutcomeStatus {
    ForgePullRequestRunnerOutcomeStatus::DuplicateNoop
}
