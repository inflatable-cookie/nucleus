use super::super::status_check_smoke_types::{
    ProviderLiveReadStatusCheckSmokeTargetBlocker, ProviderLiveReadStatusCheckSmokeTargetInput,
    ProviderLiveReadStatusCheckSmokeTargetRecord, ProviderLiveReadStatusCheckSmokeTargetStatus,
    GH_PR_CHECKS_FIELDS,
};

pub fn provider_live_read_status_check_smoke_target(
    input: ProviderLiveReadStatusCheckSmokeTargetInput,
) -> ProviderLiveReadStatusCheckSmokeTargetRecord {
    let blockers = target_blockers(&input);
    let status = if blockers
        .iter()
        .any(|blocker| effectful_target_blockers().contains(blocker))
    {
        ProviderLiveReadStatusCheckSmokeTargetStatus::Blocked
    } else if blockers.is_empty() {
        ProviderLiveReadStatusCheckSmokeTargetStatus::Selected
    } else {
        ProviderLiveReadStatusCheckSmokeTargetStatus::RepairRequired
    };

    ProviderLiveReadStatusCheckSmokeTargetRecord {
        smoke_target_id: format!(
            "provider-live-read-status-check-smoke-target:{}",
            input.smoke_target_ref
        ),
        smoke_target_ref: input.smoke_target_ref,
        remote_repo_ref: input.remote_repo_ref,
        pull_request_ref: input.pull_request_ref,
        json_fields: GH_PR_CHECKS_FIELDS
            .iter()
            .map(|field| (*field).to_owned())
            .collect(),
        smoke_target_evidence_ref: input.smoke_target_evidence_ref,
        status,
        blockers,
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn target_blockers(
    input: &ProviderLiveReadStatusCheckSmokeTargetInput,
) -> Vec<ProviderLiveReadStatusCheckSmokeTargetBlocker> {
    let mut blockers = Vec::new();
    if input.smoke_target_ref.is_empty() {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::MissingSmokeTargetRef);
    }
    if input.remote_repo_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::MissingRemoteRepoRef);
    }
    if input.pull_request_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::MissingPullRequestRef);
    }
    if input.smoke_target_evidence_ref.is_none() {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::MissingSmokeTargetEvidenceRef);
    }
    if input.provider_write_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::ProviderWriteRequested);
    }
    if input.task_mutation_requested {
        blockers.push(ProviderLiveReadStatusCheckSmokeTargetBlocker::TaskMutationRequested);
    }
    if input.raw_provider_payload_retention_requested {
        blockers.push(
            ProviderLiveReadStatusCheckSmokeTargetBlocker::RawProviderPayloadRetentionRequested,
        );
    }
    blockers
}

fn effectful_target_blockers() -> [ProviderLiveReadStatusCheckSmokeTargetBlocker; 3] {
    [
        ProviderLiveReadStatusCheckSmokeTargetBlocker::ProviderWriteRequested,
        ProviderLiveReadStatusCheckSmokeTargetBlocker::TaskMutationRequested,
        ProviderLiveReadStatusCheckSmokeTargetBlocker::RawProviderPayloadRetentionRequested,
    ]
}
