//! Sanitized Codex startup and transport receipt mappings.
//!
//! These helpers produce runtime receipt records from admission and frame
//! source records. They do not spawn, decode, replay, or retain raw streams.

use nucleus_engine::{
    EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
    EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
};

use super::spawn_intent::{
    CodexAppServerSpawnIntentAdmission, CodexAppServerSpawnIntentAdmissionStatus,
};
use super::stdio_frames::{CodexAppServerStdioDecodeStatus, CodexAppServerStdioFrameSourceRecord};

/// Transport receipt class for Codex startup and frame handling.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTransportReceiptKind {
    StartupBlocked,
    StartupAccepted,
    FrameDecoded,
    FrameMalformed,
    FrameUnsupported,
    FrameRecoveryRequired,
}

/// Map a spawn-intent admission to a sanitized runtime receipt.
pub fn codex_receipt_from_spawn_intent(
    admission: &CodexAppServerSpawnIntentAdmission,
) -> EngineRuntimeReceiptRecord {
    let status = match admission.status {
        CodexAppServerSpawnIntentAdmissionStatus::Accepted => EngineRuntimeReceiptStatus::Accepted,
        CodexAppServerSpawnIntentAdmissionStatus::Blocked(_) => EngineRuntimeReceiptStatus::Blocked,
    };

    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:spawn-intent",
            admission.intent_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            admission.intent_id.0.clone(),
        )),
        evidence_refs: admission
            .evidence_refs
            .iter()
            .map(|value| EngineRuntimeReceiptRef::Custom(value.clone()))
            .collect(),
        artifact_refs: Vec::new(),
        summary: Some(spawn_intent_summary(admission)),
    }
}

/// Map a stdio frame source record to a sanitized runtime receipt.
pub fn codex_receipt_from_stdio_frame(
    frame: &CodexAppServerStdioFrameSourceRecord,
) -> EngineRuntimeReceiptRecord {
    let (status, summary) = match &frame.decode_status {
        CodexAppServerStdioDecodeStatus::Decoded { method } => (
            EngineRuntimeReceiptStatus::Accepted,
            format!("Codex frame decoded: {method}"),
        ),
        CodexAppServerStdioDecodeStatus::Malformed { reason } => (
            EngineRuntimeReceiptStatus::Failed,
            format!("Codex frame malformed: {reason}"),
        ),
        CodexAppServerStdioDecodeStatus::Unsupported { method, reason } => (
            EngineRuntimeReceiptStatus::Blocked,
            format!(
                "Codex frame unsupported{}: {reason}",
                method
                    .as_ref()
                    .map(|value| format!(" ({value})"))
                    .unwrap_or_default()
            ),
        ),
        CodexAppServerStdioDecodeStatus::RecoveryRequired { reason } => (
            EngineRuntimeReceiptStatus::RecoveryRequired,
            format!("Codex frame requires recovery: {reason}"),
        ),
    };

    EngineRuntimeReceiptRecord {
        receipt_id: EngineRuntimeReceiptRecordId(format!(
            "receipt:{}:decode",
            frame.frame_source_id.0
        )),
        family: EngineRuntimeReceiptEffectFamily::HarnessProvider,
        status,
        command_ref: None,
        effect_ref: Some(EngineRuntimeReceiptRef::Custom(
            frame.runtime_instance_id.clone(),
        )),
        evidence_refs: vec![EngineRuntimeReceiptRef::Custom(frame.evidence_ref.clone())],
        artifact_refs: Vec::new(),
        summary: Some(summary),
    }
}

fn spawn_intent_summary(admission: &CodexAppServerSpawnIntentAdmission) -> String {
    match &admission.status {
        CodexAppServerSpawnIntentAdmissionStatus::Accepted => {
            "Codex spawn intent accepted; process not started".to_owned()
        }
        CodexAppServerSpawnIntentAdmissionStatus::Blocked(reason) => {
            format!("Codex spawn intent blocked: {reason}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerRuntimeInstanceState, CodexAppServerSchemaEvidenceRef,
        CodexAppServerSupervisionLimits, CodexAppServerSupervisionRequest,
    };
    use crate::codex_supervision::{
        codex_stdio_frame_source_record, CodexAppServerSpawnIntentAdmissionStatus,
        CodexAppServerSpawnIntentId, CodexAppServerStdioFrameDirection,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    fn runtime() -> crate::CodexAppServerRuntimeInstanceRecord {
        let request = CodexAppServerSupervisionRequest {
            project_id: ProjectId("project:1".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            adapter: AdapterIdentity {
                adapter_id: "codex-app-server".to_owned(),
                provider_driver_kind: ProviderDriverKind::Codex,
                provider_instance_id: "codex:local-default".to_owned(),
                provider_name: "OpenAI Codex".to_owned(),
                harness_name: "Codex app-server".to_owned(),
                transport_family: TransportFamily::StructuredAppServerRuntime,
                version_discovery: VersionDiscovery::Command("codex --version".to_owned()),
                authentication_preflight: AuthenticationPreflight::Command(
                    "codex doctor --json".to_owned(),
                ),
            },
            binary: CodexAppServerBinary {
                command: "codex".to_owned(),
                version_label: Some("codex-cli 0.140.0".to_owned()),
                available: true,
            },
            schema_evidence: CodexAppServerSchemaEvidenceRef {
                evidence_ref: "evidence:codex-schema".to_owned(),
                codex_version: "codex-cli 0.140.0".to_owned(),
                generated_json_schema: true,
                generated_ts_bindings: true,
            },
            supervision_limits: CodexAppServerSupervisionLimits {
                max_sessions: 1,
                allow_raw_provider_payload_storage: false,
                allow_live_spawn: true,
            },
        };
        codex_runtime_instance_from_supervision_request(
            &request,
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    #[test]
    fn blocked_spawn_intent_becomes_sanitized_receipt() {
        let receipt = codex_receipt_from_spawn_intent(&CodexAppServerSpawnIntentAdmission {
            intent_id: CodexAppServerSpawnIntentId("intent:1".to_owned()),
            runtime_instance_id: "runtime:1".to_owned(),
            status: CodexAppServerSpawnIntentAdmissionStatus::Blocked("missing auth".to_owned()),
            blockers: Vec::new(),
            spawn_started: false,
            evidence_refs: vec!["evidence:auth".to_owned()],
        });

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Blocked);
        assert_eq!(
            receipt.family,
            EngineRuntimeReceiptEffectFamily::HarnessProvider
        );
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("blocked"));
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn malformed_frame_becomes_failed_receipt_without_raw_payload() {
        let frame = codex_stdio_frame_source_record(
            &runtime(),
            CodexAppServerStdioFrameDirection::ProviderStdout,
            9,
            CodexAppServerStdioDecodeStatus::Malformed {
                reason: "invalid json".to_owned(),
            },
        );

        let receipt = codex_receipt_from_stdio_frame(&frame);

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::Failed);
        assert_eq!(receipt.evidence_refs.len(), 1);
        assert!(receipt
            .summary
            .as_deref()
            .unwrap_or_default()
            .contains("malformed"));
        assert!(receipt.artifact_refs.is_empty());
    }

    #[test]
    fn recovery_required_frame_stays_recovery_required() {
        let frame = codex_stdio_frame_source_record(
            &runtime(),
            CodexAppServerStdioFrameDirection::ProviderStdout,
            10,
            CodexAppServerStdioDecodeStatus::RecoveryRequired {
                reason: "stream generation changed".to_owned(),
            },
        );

        let receipt = codex_receipt_from_stdio_frame(&frame);

        assert_eq!(receipt.status, EngineRuntimeReceiptStatus::RecoveryRequired);
    }
}
