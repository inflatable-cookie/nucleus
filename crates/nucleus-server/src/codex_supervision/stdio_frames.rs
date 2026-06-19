//! Codex app-server stdio frame source records.
//!
//! These records describe frame provenance and decode outcomes. They do not
//! open stdio, retain raw frames, or parse live bytes.

use super::runtime_instance::{
    CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceRecord,
};

/// Stable id for one observed stdio frame source.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerStdioFrameSourceId(pub String);

/// Stdio direction for a Codex app-server frame.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerStdioFrameDirection {
    ProviderStdout,
    ProviderStderr,
    ClientStdin,
}

/// Decode status before a frame enters Codex observation acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerStdioDecodeStatus {
    Decoded {
        method: String,
    },
    Malformed {
        reason: String,
    },
    Unsupported {
        method: Option<String>,
        reason: String,
    },
    RecoveryRequired {
        reason: String,
    },
}

/// Source record for one stdio frame before event acceptance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerStdioFrameSourceRecord {
    pub frame_source_id: CodexAppServerStdioFrameSourceId,
    pub runtime_instance_id: String,
    pub direction: CodexAppServerStdioFrameDirection,
    pub sequence: u64,
    pub decode_status: CodexAppServerStdioDecodeStatus,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub evidence_ref: String,
}

/// Build a frame source record without reading or retaining raw stdio bytes.
pub fn codex_stdio_frame_source_record(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    direction: CodexAppServerStdioFrameDirection,
    sequence: u64,
    decode_status: CodexAppServerStdioDecodeStatus,
) -> CodexAppServerStdioFrameSourceRecord {
    CodexAppServerStdioFrameSourceRecord {
        frame_source_id: CodexAppServerStdioFrameSourceId(format!(
            "codex-frame-source:{}:{sequence}",
            runtime.runtime_instance_id.0
        )),
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        direction,
        sequence,
        decode_status,
        payload_retention: runtime.payload_retention.clone(),
        evidence_ref: format!(
            "evidence:codex-frame:{}:{sequence}",
            runtime.runtime_instance_id.0
        ),
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
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    fn runtime() -> CodexAppServerRuntimeInstanceRecord {
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
                allow_live_spawn: false,
            },
        };
        codex_runtime_instance_from_supervision_request(
            &request,
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        )
    }

    #[test]
    fn decoded_frame_source_keeps_runtime_and_method_refs() {
        let record = codex_stdio_frame_source_record(
            &runtime(),
            CodexAppServerStdioFrameDirection::ProviderStdout,
            7,
            CodexAppServerStdioDecodeStatus::Decoded {
                method: "turn/completed".to_owned(),
            },
        );

        assert_eq!(record.sequence, 7);
        assert!(matches!(
            record.decode_status,
            CodexAppServerStdioDecodeStatus::Decoded { .. }
        ));
        assert_eq!(
            record.payload_retention,
            CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
        assert!(record.evidence_ref.contains("codex-frame"));
    }

    #[test]
    fn malformed_frame_source_does_not_require_raw_payload_retention() {
        let record = codex_stdio_frame_source_record(
            &runtime(),
            CodexAppServerStdioFrameDirection::ProviderStdout,
            8,
            CodexAppServerStdioDecodeStatus::Malformed {
                reason: "invalid json".to_owned(),
            },
        );

        assert!(matches!(
            record.decode_status,
            CodexAppServerStdioDecodeStatus::Malformed { .. }
        ));
        assert_eq!(
            record.payload_retention,
            CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
    }
}
