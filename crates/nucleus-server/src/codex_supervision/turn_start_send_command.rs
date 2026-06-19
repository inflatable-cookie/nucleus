//! Codex turn-start provider-send command records.
//!
//! Command records prepare a provider write from an accepted envelope. They do
//! not write to stdio, open subscriptions, retain raw payloads, or mutate task
//! state.

use super::runtime_instance::CodexAppServerPayloadRetentionPolicy;
use super::turn_start_envelope::CodexAppServerTurnStartEnvelopeRecord;

/// Stable id for one provider-send command.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerTurnStartSendCommandId(pub String);

/// Target transport for the provider send.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartWriteTarget {
    Stdio,
    Custom(String),
}

/// Provider-send command record for a turn-start envelope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerTurnStartSendCommandRecord {
    pub command_id: CodexAppServerTurnStartSendCommandId,
    pub envelope_id: String,
    pub request_id: String,
    pub method: String,
    pub write_target: CodexAppServerTurnStartWriteTarget,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub evidence_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub provider_write_started: bool,
    pub callback_response_permitted: bool,
    pub cancellation_permitted: bool,
    pub task_mutation_permitted: bool,
}

/// Rejection before a provider-send command can exist.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerTurnStartSendCommandRejection {
    RawProviderPayloadRetentionNotAllowed,
    EmptyEnvelopeId,
    EmptyRequestId,
}

/// Build a provider-send command record without writing to the provider.
pub fn codex_turn_start_send_command(
    envelope: &CodexAppServerTurnStartEnvelopeRecord,
    write_target: CodexAppServerTurnStartWriteTarget,
) -> Result<CodexAppServerTurnStartSendCommandRecord, CodexAppServerTurnStartSendCommandRejection> {
    if envelope.envelope_id.0.is_empty() {
        return Err(CodexAppServerTurnStartSendCommandRejection::EmptyEnvelopeId);
    }
    if envelope.request_id.is_empty() {
        return Err(CodexAppServerTurnStartSendCommandRejection::EmptyRequestId);
    }
    if envelope.payload_retention
        == CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed
    {
        return Err(
            CodexAppServerTurnStartSendCommandRejection::RawProviderPayloadRetentionNotAllowed,
        );
    }

    Ok(CodexAppServerTurnStartSendCommandRecord {
        command_id: CodexAppServerTurnStartSendCommandId(format!(
            "codex-turn-start-send:{}",
            envelope.envelope_id.0
        )),
        envelope_id: envelope.envelope_id.0.clone(),
        request_id: envelope.request_id.clone(),
        method: envelope.method.clone(),
        write_target,
        payload_retention: envelope.payload_retention.clone(),
        evidence_refs: envelope.evidence_refs.clone(),
        raw_payload_retained: false,
        provider_write_started: false,
        callback_response_permitted: false,
        cancellation_permitted: false,
        task_mutation_permitted: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        admit_codex_turn_start, codex_runtime_instance_from_supervision_request,
        codex_turn_start_envelope, codex_turn_start_request, CodexAppServerBinary,
        CodexAppServerPayloadRetentionPolicy, CodexAppServerRuntimeInstanceState,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest, CodexAppServerTurnStartAdmissionInput,
        CodexAppServerTurnStartDeferredPolicy, CodexAppServerTurnStartPromptRef,
        CodexAppServerTurnStartPromptRetentionPolicy,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AgentSessionId, AuthenticationPreflight, ProviderDriverKind,
        TransportFamily, VersionDiscovery,
    };
    use nucleus_engine::EngineTaskWorkItemId;
    use nucleus_projects::ProjectId;
    use nucleus_tasks::TaskId;

    fn envelope() -> CodexAppServerTurnStartEnvelopeRecord {
        let runtime = codex_runtime_instance_from_supervision_request(
            &CodexAppServerSupervisionRequest {
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
            },
            CodexAppServerRuntimeInstanceState::ReadyForSpawn,
        );
        let request = codex_turn_start_request(
            &runtime,
            AgentSessionId("session:1".to_owned()),
            TaskId("task:1".to_owned()),
            EngineTaskWorkItemId("work:1".to_owned()),
            CodexAppServerTurnStartPromptRef {
                prompt_ref: "prompt:1".to_owned(),
                summary: "turn prompt summary".to_owned(),
                retention: CodexAppServerTurnStartPromptRetentionPolicy::SummaryAndRefOnly,
            },
            CodexAppServerPayloadRetentionPolicy::MetadataOnly,
        )
        .expect("turn request");
        let admission = admit_codex_turn_start(CodexAppServerTurnStartAdmissionInput {
            request: request.clone(),
            runtime_ready_evidence_refs: vec!["evidence:live-spawn-smoke".to_owned()],
            task_work_ready: true,
            assignment_ready: true,
            callback_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            cancellation_policy: CodexAppServerTurnStartDeferredPolicy::ExplicitlyDeferred,
            raw_payload_policy_confirmed: true,
        });

        codex_turn_start_envelope(&request, &admission).expect("envelope")
    }

    #[test]
    fn provider_send_command_requires_envelope_without_writing() {
        let command =
            codex_turn_start_send_command(&envelope(), CodexAppServerTurnStartWriteTarget::Stdio)
                .expect("send command");

        assert_eq!(command.method, "turn/start");
        assert!(command.command_id.0.contains(&command.envelope_id));
        assert_eq!(
            command.write_target,
            CodexAppServerTurnStartWriteTarget::Stdio
        );
        assert!(!command.provider_write_started);
        assert!(!command.raw_payload_retained);
        assert!(!command.callback_response_permitted);
        assert!(!command.cancellation_permitted);
        assert!(!command.task_mutation_permitted);
    }

    #[test]
    fn provider_send_command_rejects_raw_payload_retention() {
        let mut envelope = envelope();
        envelope.payload_retention =
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed;

        assert_eq!(
            codex_turn_start_send_command(&envelope, CodexAppServerTurnStartWriteTarget::Stdio)
                .expect_err("raw payload rejected"),
            CodexAppServerTurnStartSendCommandRejection::RawProviderPayloadRetentionNotAllowed
        );
    }
}
