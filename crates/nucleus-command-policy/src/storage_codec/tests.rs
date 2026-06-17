use super::*;
use crate::CommandEvidenceId;
use crate::{
    CommandApprovalPolicy, CommandAuthorityArea, CommandEvidence, CommandExecutionRequest,
    CommandExecutionStatus, CommandOutputRetention, CommandPolicyId, CommandRequestId, CommandRisk,
    CommandSandboxProfile, CommandScope,
};

#[test]
fn command_request_storage_codec_preserves_metadata() {
    let request = CommandExecutionRequest {
        id: CommandRequestId("command:request:1".to_owned()),
        policy_id: Some(CommandPolicyId("command:policy:readonly".to_owned())),
        authority_area: CommandAuthorityArea::Validation,
        scope: CommandScope::ReadOnlyInspection,
        risk: CommandRisk::Low,
        sandbox: CommandSandboxProfile::NoFilesystemWrite,
        approval: CommandApprovalPolicy::AutoAllowed,
        command_display: Some("cargo check --workspace".to_owned()),
        working_directory_hint: Some("/workspace/nucleus".to_owned()),
    };

    let bytes = encode_command_request_storage_record(&request).expect("encode request");
    let decoded = decode_command_request_storage_record(&bytes).expect("decode request");
    let restored = command_request_from_storage_record(&decoded);

    assert_eq!(restored, request);
}

#[test]
fn command_evidence_storage_codec_preserves_sanitized_metadata() {
    let evidence = CommandEvidence {
        id: CommandEvidenceId("command:evidence:1".to_owned()),
        request_id: CommandRequestId("command:request:1".to_owned()),
        status: CommandExecutionStatus::Succeeded,
        exit_status: Some(0),
        retention: CommandOutputRetention::ArtifactReference,
        summary: Some("workspace check passed".to_owned()),
        stdout_artifact_ref: Some("artifact:stdout:1".to_owned()),
        stderr_artifact_ref: None,
    };

    let bytes = encode_command_evidence_storage_record(&evidence).expect("encode evidence");
    let decoded = decode_command_evidence_storage_record(&bytes).expect("decode evidence");
    let restored = command_evidence_from_storage_record(&decoded);

    assert_eq!(restored, evidence);
}

#[test]
fn command_evidence_storage_payload_has_no_raw_output_fields() {
    let evidence = CommandEvidence {
        id: CommandEvidenceId("command:evidence:1".to_owned()),
        request_id: CommandRequestId("command:request:1".to_owned()),
        status: CommandExecutionStatus::Failed,
        exit_status: Some(1),
        retention: CommandOutputRetention::SummaryOnly,
        summary: Some("command failed; see retained evidence policy".to_owned()),
        stdout_artifact_ref: None,
        stderr_artifact_ref: None,
    };

    let bytes = encode_command_evidence_storage_record(&evidence).expect("encode evidence");
    let json = String::from_utf8(bytes).expect("json should be utf8");

    for forbidden in [
        "raw_stdout",
        "raw_stderr",
        "stdout_bytes",
        "stderr_bytes",
        "terminal_stream",
        "shell_trace",
        "environment",
        "credential",
    ] {
        assert!(
            !json.contains(forbidden),
            "storage payload should not contain {forbidden}"
        );
    }
}
