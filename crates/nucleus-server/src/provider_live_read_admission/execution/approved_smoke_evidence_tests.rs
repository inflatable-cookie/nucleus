use super::*;

#[test]
fn approved_smoke_evidence_promotes_selected_fields_without_raw_payloads() {
    let evidence = provider_live_read_approved_smoke_evidence(evidence_input(false));
    let diagnostics =
        provider_live_read_approved_smoke_evidence_diagnostics(vec![evidence.clone()]);
    let json = serde_json::to_string(&evidence).expect("serialize evidence");

    assert_eq!(
        evidence.status,
        ProviderLiveReadApprovedSmokeEvidenceStatus::Promoted
    );
    assert_eq!(
        evidence.name_with_owner,
        Some("octocat/Hello-World".to_owned())
    );
    assert_eq!(evidence.default_branch, Some("master".to_owned()));
    assert_eq!(evidence.viewer_permission, Some("READ".to_owned()));
    assert_eq!(diagnostics.promoted_count, 1);
    assert_eq!(diagnostics.provider_network_read_performed_count, 1);
    assert!(!diagnostics.provider_write_executed);
    assert!(!diagnostics.raw_provider_payload_retained);
    assert_sanitized_json(&json);
}

#[test]
fn approved_smoke_evidence_requires_stopped_request_and_sanitized_mapping() {
    let mut input = evidence_input(false);
    input.request.status = ProviderLiveReadCommandSmokeRequestStatus::ApprovalRequired;
    input.mapping.status = ProviderLiveReadCommandResultMappingStatus::ParseError;
    input.mapping.receipt.status = ProviderLiveReadServerReceiptStatus::Blocked;

    let evidence = provider_live_read_approved_smoke_evidence(input);

    assert_eq!(
        evidence.status,
        ProviderLiveReadApprovedSmokeEvidenceStatus::Blocked
    );
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::CommandSmokeRequestNotStopped));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::MappingNotSanitized));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::ReceiptNotProviderReadPerformed));
}

#[test]
fn approved_smoke_evidence_blocks_effectful_or_raw_retaining_results() {
    let evidence = provider_live_read_approved_smoke_evidence(evidence_input(true));
    let diagnostics =
        provider_live_read_approved_smoke_evidence_diagnostics(vec![evidence.clone()]);

    assert_eq!(
        evidence.status,
        ProviderLiveReadApprovedSmokeEvidenceStatus::Blocked
    );
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::ProviderWriteExecuted));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::TaskMutationExecuted));
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::RawProviderPayloadRetained));
    assert!(diagnostics.provider_write_executed);
    assert!(diagnostics.task_mutation_executed);
    assert!(diagnostics.raw_provider_payload_retained);
}

#[test]
fn approved_smoke_evidence_represents_missing_evidence_ref_as_repair_required() {
    let mut input = evidence_input(false);
    input.evidence_ref = None;

    let evidence = provider_live_read_approved_smoke_evidence(input);

    assert_eq!(
        evidence.status,
        ProviderLiveReadApprovedSmokeEvidenceStatus::RepairRequired
    );
    assert!(evidence
        .blockers
        .contains(&ProviderLiveReadApprovedSmokeEvidenceBlocker::MissingEvidenceRef));
}

fn evidence_input(forbidden: bool) -> ProviderLiveReadApprovedSmokeEvidenceInput {
    ProviderLiveReadApprovedSmokeEvidenceInput {
        request: request(),
        mapping: mapping(forbidden),
        evidence_ref: Some("evidence:provider-live-read-approved-smoke".to_owned()),
        existing_evidence_ids: Vec::new(),
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
    }
}

fn request() -> ProviderLiveReadCommandSmokeRequestRecord {
    ProviderLiveReadCommandSmokeRequestRecord {
        request_id: "command-smoke-request:repo-metadata".to_owned(),
        command_smoke_request_ref: Some("command-smoke-request:github-repo-view".to_owned()),
        checklist_id: "command-smoke-checklist:repo-metadata".to_owned(),
        smoke_target_id: "command-smoke-target:repo-metadata".to_owned(),
        command_descriptor_id: "command-descriptor:repo-metadata".to_owned(),
        handoff_id: "command-handoff:repo-metadata".to_owned(),
        expected_command_line: vec![
            "gh".to_owned(),
            "repo".to_owned(),
            "view".to_owned(),
            "octocat/Hello-World".to_owned(),
            "--json".to_owned(),
            "nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt"
                .to_owned(),
        ],
        request_evidence_ref: Some("evidence:command-smoke-request".to_owned()),
        status: ProviderLiveReadCommandSmokeRequestStatus::StoppedPendingExplicitExecution,
        blockers: Vec::new(),
        duplicate_request_detected: false,
        provider_network_call_performed: false,
        credential_resolution_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn mapping(forbidden: bool) -> ProviderLiveReadCommandResultMappingRecord {
    ProviderLiveReadCommandResultMappingRecord {
        mapping_id: "command-result-mapping:repo-metadata".to_owned(),
        handoff_id: "command-handoff:repo-metadata".to_owned(),
        command_descriptor_id: "command-descriptor:repo-metadata".to_owned(),
        executor_request_id: "executor-request:repo-metadata".to_owned(),
        output: output(),
        receipt: receipt(forbidden),
        status: if forbidden {
            ProviderLiveReadCommandResultMappingStatus::Blocked
        } else {
            ProviderLiveReadCommandResultMappingStatus::MappedSanitizedOutput
        },
        blockers: Vec::new(),
        provider_network_call_performed: true,
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
    }
}

fn output() -> ProviderLiveReadSanitizedRepositoryMetadataRecord {
    ProviderLiveReadSanitizedRepositoryMetadataRecord {
        output_record_id: "sanitized-output:repo-metadata".to_owned(),
        command_descriptor_id: "command-descriptor:repo-metadata".to_owned(),
        executor_request_id: "executor-request:repo-metadata".to_owned(),
        name_with_owner: Some("octocat/Hello-World".to_owned()),
        default_branch: Some("master".to_owned()),
        is_private: Some(false),
        visibility: Some("PUBLIC".to_owned()),
        url: Some("https://github.com/octocat/Hello-World".to_owned()),
        viewer_permission: Some("READ".to_owned()),
        pushed_at: Some("2024-08-20T23:54:42Z".to_owned()),
        updated_at: Some("2026-06-22T20:17:08Z".to_owned()),
        status: ProviderLiveReadSanitizedRepositoryMetadataStatus::Sanitized,
        blockers: Vec::new(),
        provider_network_call_performed: true,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn receipt(forbidden: bool) -> ProviderLiveReadServerReceiptRecord {
    ProviderLiveReadServerReceiptRecord {
        receipt_id: "receipt:repo-metadata".to_owned(),
        executor_request_id: "executor-request:repo-metadata".to_owned(),
        command_descriptor_id: "command-descriptor:repo-metadata".to_owned(),
        output_record_id: "sanitized-output:repo-metadata".to_owned(),
        provider_exit_code: Some(0),
        receipt_evidence_ref: Some("evidence:provider-live-read-receipt".to_owned()),
        status: if forbidden {
            ProviderLiveReadServerReceiptStatus::Blocked
        } else {
            ProviderLiveReadServerReceiptStatus::ProviderReadPerformed
        },
        blockers: Vec::new(),
        provider_network_call_performed: true,
        provider_write_executed: forbidden,
        callback_effect_executed: forbidden,
        interruption_effect_executed: forbidden,
        recovery_effect_executed: forbidden,
        task_mutation_executed: forbidden,
        raw_provider_payload_retained: forbidden,
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
