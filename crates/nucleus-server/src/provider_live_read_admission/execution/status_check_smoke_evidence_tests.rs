use super::*;

#[test]
fn status_check_smoke_evidence_promotes_sanitized_live_counts() {
    let request = stopped_request();
    let evidence = provider_live_read_status_check_smoke_evidence(
        ProviderLiveReadStatusCheckSmokeEvidenceInput {
            request,
            evidence_ref: Some("evidence:status-check-smoke:cli-cli-13705".to_owned()),
            selected_command_scope_confirmed: true,
            command_exit_code: Some(0),
            check_count: 18,
            pass_count: 11,
            fail_count: 0,
            pending_count: 0,
            skipping_count: 7,
            cancel_count: 0,
            provider_network_call_performed: true,
            provider_write_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    );
    let diagnostics =
        provider_live_read_status_check_smoke_evidence_diagnostics(vec![evidence.clone()]);
    let json = serde_json::to_string(&evidence).expect("evidence json");

    assert_eq!(
        evidence.status,
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::Promoted
    );
    assert_eq!(evidence.remote_repo_ref, Some("cli/cli".to_owned()));
    assert_eq!(evidence.pull_request_ref, Some("13705".to_owned()));
    assert_eq!(evidence.check_count, 18);
    assert_eq!(evidence.pass_count, 11);
    assert_eq!(evidence.skipping_count, 7);
    assert!(evidence.provider_network_call_performed);
    assert_eq!(diagnostics.evidence_count, 1);
    assert_eq!(diagnostics.promoted_count, 1);
    assert_eq!(diagnostics.total_check_count, 18);
    assert_eq!(diagnostics.provider_network_read_performed_count, 1);
    assert_sanitized_json(&json);
}

#[test]
fn status_check_smoke_evidence_blocks_writes_and_raw_payloads() {
    let evidence = provider_live_read_status_check_smoke_evidence(
        ProviderLiveReadStatusCheckSmokeEvidenceInput {
            request: stopped_request(),
            evidence_ref: Some("evidence:status-check-smoke:blocked".to_owned()),
            selected_command_scope_confirmed: false,
            command_exit_code: Some(0),
            check_count: 1,
            pass_count: 1,
            fail_count: 0,
            pending_count: 0,
            skipping_count: 0,
            cancel_count: 0,
            provider_network_call_performed: true,
            provider_write_executed: true,
            task_mutation_executed: true,
            raw_provider_payload_retained: true,
        },
    );
    let diagnostics =
        provider_live_read_status_check_smoke_evidence_diagnostics(vec![evidence.clone()]);

    assert_eq!(
        evidence.status,
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::Blocked
    );
    assert!(evidence.blockers.contains(
        &ProviderLiveReadStatusCheckSmokeEvidenceBlocker::SelectedCommandScopeNotConfirmed
    ));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeEvidenceBlocker::ProviderWriteExecuted));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeEvidenceBlocker::TaskMutationExecuted));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeEvidenceBlocker::RawProviderPayloadRetained));
    assert_eq!(diagnostics.blocked_count, 1);
    assert!(diagnostics.provider_write_executed);
    assert!(diagnostics.task_mutation_executed);
    assert!(diagnostics.raw_provider_payload_retained);
}

#[test]
fn status_check_smoke_evidence_repairs_missing_reference_or_count_mismatch() {
    let evidence = provider_live_read_status_check_smoke_evidence(
        ProviderLiveReadStatusCheckSmokeEvidenceInput {
            request: stopped_request(),
            evidence_ref: None,
            selected_command_scope_confirmed: true,
            command_exit_code: Some(0),
            check_count: 3,
            pass_count: 1,
            fail_count: 0,
            pending_count: 0,
            skipping_count: 1,
            cancel_count: 0,
            provider_network_call_performed: true,
            provider_write_executed: false,
            task_mutation_executed: false,
            raw_provider_payload_retained: false,
        },
    );

    assert_eq!(
        evidence.status,
        ProviderLiveReadStatusCheckSmokeEvidenceStatus::RepairRequired
    );
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeEvidenceBlocker::MissingEvidenceRef));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadStatusCheckSmokeEvidenceBlocker::CheckCountMismatch));
}

fn stopped_request() -> ProviderLiveReadStatusCheckSmokeRequestRecord {
    let target =
        provider_live_read_status_check_smoke_target(ProviderLiveReadStatusCheckSmokeTargetInput {
            smoke_target_ref: "github:cli/cli:pr:13705:status-check-smoke".to_owned(),
            remote_repo_ref: Some("cli/cli".to_owned()),
            pull_request_ref: Some("13705".to_owned()),
            smoke_target_evidence_ref: Some("evidence:status-check-smoke-target".to_owned()),
            provider_write_requested: false,
            task_mutation_requested: false,
            raw_provider_payload_retention_requested: false,
        });
    let checklist = provider_live_read_status_check_smoke_checklist(
        ProviderLiveReadStatusCheckSmokeChecklistInput {
            target,
            credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
            network_read_authority_ref: Some(
                "network-authority:github-status-check-read".to_owned(),
            ),
            payload_policy_ref: Some("payload-policy:selected-status-check-json".to_owned()),
            retention_policy_ref: Some("retention:no-raw-provider-payload".to_owned()),
            operator_approval_ref: Some("approval:operator:status-check-smoke".to_owned()),
            checklist_evidence_ref: Some("evidence:status-check-smoke-checklist".to_owned()),
            credential_material_present: false,
            provider_network_call_requested: false,
            provider_write_requested: false,
            task_mutation_requested: false,
            raw_provider_payload_retention_requested: false,
        },
    );

    provider_live_read_status_check_smoke_request(ProviderLiveReadStatusCheckSmokeRequestInput {
        checklist,
        status_check_request_ref: Some("status-check-smoke-request:github-pr-checks".to_owned()),
        request_evidence_ref: Some("evidence:status-check-smoke-request".to_owned()),
        existing_request_ids: Vec::new(),
        provider_network_call_requested: false,
        credential_material_present: false,
        provider_write_requested: false,
        task_mutation_requested: false,
        raw_provider_payload_retention_requested: false,
    })
}

fn assert_sanitized_json(json: &str) {
    assert!(!json.contains("access_token"));
    assert!(!json.contains("authorization"));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("raw_stderr"));
    assert!(!json.contains("credential_material"));
    assert!(!json.contains("private_key"));
    assert!(!json.contains("27994017900"));
    assert!(!json.contains("82852290436"));
}
