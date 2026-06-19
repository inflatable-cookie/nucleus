//! Codex app-server owned-runtime instance records.
//!
//! Runtime instance records describe process intent and ownership. They do not
//! hold process handles, spawn Codex, or open stdio.

use nucleus_agent_protocol::{AdapterIdentity, RuntimeProcessOwner};

use crate::host_authority::EngineHostId;

use super::readiness::{CodexAppServerBinary, CodexAppServerSupervisionRequest};

/// Stable id for one Nucleus-owned Codex runtime instance.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerRuntimeInstanceId(pub String);

/// Descriptive runtime instance record before process spawning exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerRuntimeInstanceRecord {
    pub runtime_instance_id: CodexAppServerRuntimeInstanceId,
    pub execution_host_id: EngineHostId,
    pub adapter: AdapterIdentity,
    pub process_owner: RuntimeProcessOwner,
    pub binary: CodexAppServerBinary,
    pub endpoint_label: String,
    pub payload_retention: CodexAppServerPayloadRetentionPolicy,
    pub state: CodexAppServerRuntimeInstanceState,
    pub evidence_refs: Vec<String>,
}

/// Raw provider payload retention policy for this runtime instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerPayloadRetentionPolicy {
    MetadataOnly,
    EvidenceRefsOnly,
    RawProviderPayloadsAllowed,
}

/// Local lifecycle state for a runtime instance record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerRuntimeInstanceState {
    Planned,
    ReadyForSpawn,
    Blocked(String),
    Exited(String),
}

/// Build a descriptive runtime instance record from a supervision request.
pub fn codex_runtime_instance_from_supervision_request(
    request: &CodexAppServerSupervisionRequest,
    state: CodexAppServerRuntimeInstanceState,
) -> CodexAppServerRuntimeInstanceRecord {
    CodexAppServerRuntimeInstanceRecord {
        runtime_instance_id: CodexAppServerRuntimeInstanceId(format!(
            "codex-runtime:{}:{}",
            request.execution_host_id.0, request.adapter.provider_instance_id
        )),
        execution_host_id: request.execution_host_id.clone(),
        adapter: request.adapter.clone(),
        process_owner: RuntimeProcessOwner::Nucleus,
        binary: request.binary.clone(),
        endpoint_label: "stdio://codex-app-server".to_owned(),
        payload_retention: if request
            .supervision_limits
            .allow_raw_provider_payload_storage
        {
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed
        } else {
            CodexAppServerPayloadRetentionPolicy::MetadataOnly
        },
        state,
        evidence_refs: vec![request.schema_evidence.evidence_ref.clone()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AuthenticationPreflight, ProviderDriverKind, TransportFamily, VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    use crate::codex_supervision::{
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
    };

    fn request(allow_raw_payloads: bool) -> CodexAppServerSupervisionRequest {
        CodexAppServerSupervisionRequest {
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
                allow_raw_provider_payload_storage: allow_raw_payloads,
                allow_live_spawn: false,
            },
        }
    }

    #[test]
    fn runtime_instance_record_is_nucleus_owned_and_pre_spawn() {
        let record = codex_runtime_instance_from_supervision_request(
            &request(false),
            CodexAppServerRuntimeInstanceState::Planned,
        );

        assert_eq!(
            record.execution_host_id,
            EngineHostId("host:local".to_owned())
        );
        assert_eq!(record.process_owner, RuntimeProcessOwner::Nucleus);
        assert_eq!(
            record.payload_retention,
            CodexAppServerPayloadRetentionPolicy::MetadataOnly
        );
        assert_eq!(record.state, CodexAppServerRuntimeInstanceState::Planned);
        assert!(record.endpoint_label.contains("stdio"));
        assert_eq!(
            record.evidence_refs,
            vec!["evidence:codex-schema".to_owned()]
        );
    }

    #[test]
    fn raw_payload_retention_must_be_explicit_on_instance_record() {
        let record = codex_runtime_instance_from_supervision_request(
            &request(true),
            CodexAppServerRuntimeInstanceState::Blocked(
                "raw provider payload storage requested".to_owned(),
            ),
        );

        assert_eq!(
            record.payload_retention,
            CodexAppServerPayloadRetentionPolicy::RawProviderPayloadsAllowed
        );
        assert!(matches!(
            record.state,
            CodexAppServerRuntimeInstanceState::Blocked(_)
        ));
    }
}
