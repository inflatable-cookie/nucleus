use super::*;

#[test]
fn command_smoke_target_names_exact_read_only_handoff_without_effects() {
    let target = provider_live_read_command_smoke_target(target_input(false));
    let json = serde_json::to_string(&target).expect("serialize target");

    assert_eq!(
        target.status,
        ProviderLiveReadCommandSmokeTargetStatus::Selected
    );
    assert_eq!(target.executable, "gh");
    assert_eq!(
        target.argv,
        vec![
            "repo",
            "view",
            "octocat/Hello-World",
            "--json",
            "nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt"
        ]
    );
    assert_eq!(
        target.command_descriptor_id,
        "command-descriptor:provider-live-read:gh-repo-view:executor-request:repo".to_owned()
    );
    assert_eq!(
        target.handoff_id,
        "provider-live-read-command-handoff:command-descriptor:provider-live-read:gh-repo-view:executor-request:repo"
    );
    assert!(!target.provider_network_call_performed);
    assert!(!target.provider_write_executed);
    assert!(!target.task_mutation_executed);
    assert_sanitized_json(&json);
}

#[test]
fn command_smoke_approval_requires_operator_approval_before_request_ready() {
    let approval = provider_live_read_command_smoke_approval(approval_input(None, false));
    let request = provider_live_read_command_smoke_request(request_input(approval.clone(), false));
    let diagnostics = provider_live_read_command_smoke_diagnostics(
        Vec::new(),
        vec![approval],
        vec![request.clone()],
    );

    assert_eq!(
        request.status,
        ProviderLiveReadCommandSmokeRequestStatus::ApprovalRequired
    );
    assert!(request
        .blockers
        .contains(&ProviderLiveReadCommandSmokeRequestBlocker::MissingOperatorApprovalRef));
    assert_eq!(diagnostics.approval_required_count, 2);
    assert_eq!(diagnostics.stopped_request_count, 0);
    assert!(!diagnostics.provider_network_call_performed);
    assert!(!diagnostics.raw_provider_payload_retained);
}

#[test]
fn command_smoke_request_stops_after_approval_without_running_gh() {
    let target = provider_live_read_command_smoke_target(target_input(false));
    let approval = provider_live_read_command_smoke_approval(approval_input(
        Some("approval:operator:command-smoke".to_owned()),
        false,
    ));
    let request = provider_live_read_command_smoke_request(request_input(approval, false));
    let diagnostics = provider_live_read_command_smoke_diagnostics(
        vec![target],
        Vec::new(),
        vec![request.clone()],
    );
    let json = serde_json::to_string(&request).expect("serialize request");

    assert_eq!(
        request.status,
        ProviderLiveReadCommandSmokeRequestStatus::StoppedPendingExplicitExecution
    );
    assert_eq!(
        request.expected_command_line,
        vec![
            "gh",
            "repo",
            "view",
            "octocat/Hello-World",
            "--json",
            "nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt",
        ]
    );
    assert!(request.blockers.is_empty());
    assert_eq!(diagnostics.selected_target_count, 1);
    assert_eq!(diagnostics.stopped_request_count, 1);
    assert!(!request.provider_network_call_performed);
    assert!(!request.credential_resolution_performed);
    assert!(!request.provider_write_executed);
    assert!(!request.task_mutation_executed);
    assert_sanitized_json(&json);
}

#[test]
fn command_smoke_blocks_provider_effects_and_raw_payload_retention() {
    let target = provider_live_read_command_smoke_target(target_input(true));
    let approval = provider_live_read_command_smoke_approval(approval_input(
        Some("approval:operator:command-smoke".to_owned()),
        true,
    ));
    let request = provider_live_read_command_smoke_request(request_input(approval.clone(), true));
    let diagnostics = provider_live_read_command_smoke_diagnostics(
        vec![target.clone()],
        vec![approval],
        vec![request.clone()],
    );

    assert_eq!(
        target.status,
        ProviderLiveReadCommandSmokeTargetStatus::Blocked
    );
    assert!(target
        .blockers
        .contains(&ProviderLiveReadCommandSmokeTargetBlocker::ProviderWriteRequested));
    assert_eq!(
        request.status,
        ProviderLiveReadCommandSmokeRequestStatus::Blocked
    );
    assert!(request
        .blockers
        .contains(&ProviderLiveReadCommandSmokeRequestBlocker::ProviderNetworkCallRequested));
    assert!(request
        .blockers
        .contains(&ProviderLiveReadCommandSmokeRequestBlocker::CredentialMaterialPresent));
    assert!(request.blockers.contains(
        &ProviderLiveReadCommandSmokeRequestBlocker::RawProviderPayloadRetentionRequested
    ));
    assert_eq!(diagnostics.blocked_count, 3);
    assert!(!diagnostics.provider_write_executed);
    assert!(!diagnostics.raw_provider_payload_retained);
}

fn target_input(forbidden: bool) -> ProviderLiveReadCommandSmokeTargetInput {
    let descriptor = descriptor();
    let handoff = handoff(&descriptor);

    ProviderLiveReadCommandSmokeTargetInput {
        smoke_target_ref: "github:octocat/Hello-World:command-smoke".to_owned(),
        descriptor,
        handoff,
        smoke_target_evidence_ref: Some("evidence:command-smoke-target".to_owned()),
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn approval_input(
    operator_approval_ref: Option<String>,
    forbidden: bool,
) -> ProviderLiveReadCommandSmokeApprovalInput {
    ProviderLiveReadCommandSmokeApprovalInput {
        target: provider_live_read_command_smoke_target(target_input(false)),
        read_authority_ref: Some("network-authority:github-read".to_owned()),
        credential_lease_ref: Some("credential-lease:github:read-only".to_owned()),
        payload_policy_ref: Some("payload-policy:sanitized-summary-only".to_owned()),
        retention_policy_ref: Some("retention:no-raw-provider-payload".to_owned()),
        operator_approval_ref,
        checklist_evidence_ref: Some("evidence:command-smoke-checklist".to_owned()),
        credential_material_present: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn request_input(
    checklist: ProviderLiveReadCommandSmokeApprovalRecord,
    forbidden: bool,
) -> ProviderLiveReadCommandSmokeRequestInput {
    ProviderLiveReadCommandSmokeRequestInput {
        checklist,
        command_smoke_request_ref: Some("command-smoke-request:github-repo-view".to_owned()),
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
        existing_request_ids: Vec::new(),
        provider_network_call_requested: forbidden,
        credential_material_present: forbidden,
        provider_write_requested: forbidden,
        task_mutation_requested: forbidden,
        raw_provider_payload_retention_requested: forbidden,
    }
}

fn descriptor() -> ProviderLiveReadGhCommandDescriptorRecord {
    ProviderLiveReadGhCommandDescriptorRecord {
        command_descriptor_id:
            "command-descriptor:provider-live-read:gh-repo-view:executor-request:repo".to_owned(),
        executor_request_id: "executor-request:repo".to_owned(),
        remote_repo_ref: "octocat/Hello-World".to_owned(),
        executable: "gh".to_owned(),
        args: vec![
            "repo".to_owned(),
            "view".to_owned(),
            "octocat/Hello-World".to_owned(),
            "--json".to_owned(),
            "nameWithOwner,defaultBranchRef,isPrivate,visibility,url,viewerPermission,pushedAt,updatedAt"
                .to_owned(),
        ],
        json_fields: vec![
            "nameWithOwner".to_owned(),
            "defaultBranchRef".to_owned(),
            "isPrivate".to_owned(),
            "visibility".to_owned(),
            "url".to_owned(),
            "viewerPermission".to_owned(),
            "pushedAt".to_owned(),
            "updatedAt".to_owned(),
        ],
        expected_sanitized_fields: vec!["name_with_owner".to_owned()],
        status: ProviderLiveReadGhCommandDescriptorStatus::ReadyForReadOnlySpawn,
        blockers: Vec::new(),
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
    }
}

fn handoff(
    descriptor: &ProviderLiveReadGhCommandDescriptorRecord,
) -> ProviderLiveReadCommandHandoffRecord {
    ProviderLiveReadCommandHandoffRecord {
        handoff_id: format!(
            "provider-live-read-command-handoff:{}",
            descriptor.command_descriptor_id
        ),
        command_handoff_ref: Some("command-handoff:gh-repo-view".to_owned()),
        command_descriptor_id: descriptor.command_descriptor_id.clone(),
        executor_request_id: descriptor.executor_request_id.clone(),
        executable: descriptor.executable.clone(),
        argv: descriptor.args.clone(),
        working_directory_hint: Some("/tmp/nucleus-provider-live-read".to_owned()),
        timeout_ms: Some(30_000),
        stdout_limit_bytes: Some(16_384),
        stderr_limit_bytes: Some(4_096),
        status: ProviderLiveReadCommandHandoffStatus::ReadyForReadOnlyCommand,
        blockers: Vec::new(),
        duplicate_handoff_detected: false,
        provider_network_call_performed: false,
        provider_write_executed: false,
        task_mutation_executed: false,
        raw_provider_payload_retained: false,
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
