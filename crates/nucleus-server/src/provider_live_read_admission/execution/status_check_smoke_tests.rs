use super::*;

#[test]
fn status_check_smoke_target_selects_bounded_gh_pr_checks_shape() {
    let target = provider_live_read_status_check_smoke_target(target_input(false));
    let json = serde_json::to_string(&target).expect("target json");

    assert_eq!(
        target.status,
        ProviderLiveReadStatusCheckSmokeTargetStatus::Selected
    );
    assert_eq!(
        target.remote_repo_ref,
        Some("octocat/Hello-World".to_owned())
    );
    assert_eq!(target.pull_request_ref, Some("1".to_owned()));
    assert_eq!(
        target.json_fields,
        vec![
            "bucket",
            "completedAt",
            "description",
            "event",
            "link",
            "name",
            "startedAt",
            "state",
            "workflow",
        ]
    );
    assert!(!target.provider_network_call_performed);
    assert!(!target.provider_write_executed);
    assert_sanitized_json(&json);
}

#[test]
fn status_check_smoke_requires_operator_approval_before_stopped_request() {
    let checklist = provider_live_read_status_check_smoke_checklist(checklist_input(None, false));
    let request =
        provider_live_read_status_check_smoke_request(request_input(checklist.clone(), false));
    let diagnostics = provider_live_read_status_check_smoke_diagnostics(
        Vec::new(),
        vec![checklist],
        vec![request.clone()],
    );

    assert_eq!(
        request.status,
        ProviderLiveReadStatusCheckSmokeRequestStatus::ApprovalRequired
    );
    assert!(request
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeRequestBlocker::ChecklistNotReady));
    assert_eq!(diagnostics.approval_required_count, 2);
    assert_eq!(diagnostics.stopped_request_count, 0);
    assert!(!diagnostics.provider_network_call_performed);
}

#[test]
fn status_check_smoke_request_stops_after_approval_without_running_gh() {
    let target = provider_live_read_status_check_smoke_target(target_input(false));
    let checklist = provider_live_read_status_check_smoke_checklist(checklist_input(
        Some("approval:operator:status-check-smoke".to_owned()),
        false,
    ));
    let request = provider_live_read_status_check_smoke_request(request_input(checklist, false));
    let diagnostics = provider_live_read_status_check_smoke_diagnostics(
        vec![target],
        Vec::new(),
        vec![request.clone()],
    );
    let json = serde_json::to_string(&request).expect("request json");

    assert_eq!(
        request.status,
        ProviderLiveReadStatusCheckSmokeRequestStatus::StoppedPendingExplicitExecution
    );
    assert_eq!(
        request.expected_command_line,
        vec![
            "gh",
            "pr",
            "checks",
            "1",
            "-R",
            "octocat/Hello-World",
            "--json",
            "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
        ]
    );
    assert!(request.blockers.is_empty());
    assert_eq!(diagnostics.selected_target_count, 1);
    assert_eq!(diagnostics.stopped_request_count, 1);
    assert!(!request.provider_network_call_performed);
    assert!(!request.credential_resolution_performed);
    assert!(!request.provider_write_executed);
    assert!(!request.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn status_check_smoke_blocks_provider_effects_and_raw_payload_retention() {
    let target = provider_live_read_status_check_smoke_target(target_input(true));
    let checklist = provider_live_read_status_check_smoke_checklist(checklist_input(
        Some("approval:operator:status-check-smoke".to_owned()),
        true,
    ));
    let request =
        provider_live_read_status_check_smoke_request(request_input(checklist.clone(), true));
    let diagnostics = provider_live_read_status_check_smoke_diagnostics(
        vec![target.clone()],
        vec![checklist],
        vec![request.clone()],
    );

    assert_eq!(
        target.status,
        ProviderLiveReadStatusCheckSmokeTargetStatus::Blocked
    );
    assert!(target
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeTargetBlocker::ProviderWriteRequested));
    assert_eq!(
        request.status,
        ProviderLiveReadStatusCheckSmokeRequestStatus::Blocked
    );
    assert!(request
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeRequestBlocker::ProviderNetworkCallRequested));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeRequestBlocker::CredentialMaterialPresent));
    assert!(request.blockers.contains(
        &ProviderLiveReadStatusCheckSmokeRequestBlocker::RawProviderPayloadRetentionRequested
    ));
    assert_eq!(diagnostics.blocked_count, 3);
    assert!(!diagnostics.provider_write_executed);
    assert!(!diagnostics.raw_provider_payload_retained);
}

fn target_input(forbidden: bool) -> ProviderLiveReadStatusCheckSmokeTargetInput {
    ProviderLiveReadStatusCheckSmokeTargetInput {
        smoke_target_ref: "github:octocat/Hello-World:pr:1:status-check-smoke".to_owned(),
        remote_repo_ref: Some("octocat/Hello-World".to_owned()),
        pull_request_ref: Some("1".to_owned()),
        smoke_target_evidence_ref: Some("evidence:status-check-smoke-target".to_owned()),
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn checklist_input(
    operator_approval_ref: Option<String>,
    forbidden: bool,
) -> ProviderLiveReadStatusCheckSmokeChecklistInput {
    ProviderLiveReadStatusCheckSmokeChecklistInput {
        target: provider_live_read_status_check_smoke_target(target_input(false)),
        credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
        network_read_authority_ref: Some("network-authority:github-status-check-read".to_owned()),
        payload_policy_ref: Some("payload-policy:selected-status-check-json".to_owned()),
        retention_policy_ref: Some("retention:no-raw-provider-payload".to_owned()),
        operator_approval_ref,
        checklist_evidence_ref: Some("evidence:status-check-smoke-checklist".to_owned()),
        credential_material_present: forbidden,
        provider_network_call_requested: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn request_input(
    checklist: ProviderLiveReadStatusCheckSmokeChecklistRecord,
    forbidden: bool,
) -> ProviderLiveReadStatusCheckSmokeRequestInput {
    ProviderLiveReadStatusCheckSmokeRequestInput {
        checklist,
        status_check_request_ref: Some("status-check-smoke-request:github-pr-checks".to_owned()),
        request_evidence_ref: Some("evidence:status-check-smoke-request".to_owned()),
        existing_request_ids: Vec::new(),
        provider_network_call_requested: forbidden,
        credential_material_present: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn assert_sanitized_json(json: &str) {
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("credential_material"));
    assert!(!json.contains("private_key"));
}
