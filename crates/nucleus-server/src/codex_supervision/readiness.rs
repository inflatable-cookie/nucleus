use nucleus_agent_protocol::AdapterIdentity;
use nucleus_projects::ProjectId;

use crate::client_auth_posture::ClientAuthDisposition;
use crate::client_protocol::{ClientProtocolProfile, CLIENT_PROTOCOL_VERSION_V1};
use crate::host_authority::{EngineHostId, ProjectAuthorityDomain, ProjectAuthorityMap};
use crate::process_control_backend::ProcessControlBackendReadiness;
use crate::transport_readiness::{LocalTransportReadiness, LocalTransportReadinessStatus};

/// Request to prepare a Nucleus-owned Codex app-server process.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionRequest {
    pub project_id: ProjectId,
    pub execution_host_id: EngineHostId,
    pub adapter: AdapterIdentity,
    pub binary: CodexAppServerBinary,
    pub schema_evidence: CodexAppServerSchemaEvidenceRef,
    pub supervision_limits: CodexAppServerSupervisionLimits,
}

/// Codex binary descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerBinary {
    pub command: String,
    pub version_label: Option<String>,
    pub available: bool,
}

/// Non-payload evidence ref for schema/probe evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSchemaEvidenceRef {
    pub evidence_ref: String,
    pub codex_version: String,
    pub generated_json_schema: bool,
    pub generated_ts_bindings: bool,
}

/// Supervision limits before live process support exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionLimits {
    pub max_sessions: u16,
    pub allow_raw_provider_payload_storage: bool,
    pub allow_live_spawn: bool,
}

/// Input used to assess Codex app-server supervision readiness.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionReadinessInput {
    pub request: CodexAppServerSupervisionRequest,
    pub authority_map: ProjectAuthorityMap,
    pub auth_disposition: ClientAuthDisposition,
    pub protocol_profile: ClientProtocolProfile,
    pub local_transport: LocalTransportReadiness,
    pub process_control: ProcessControlBackendReadiness,
}

/// Readiness result for Codex app-server supervision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSupervisionReadiness {
    pub request: CodexAppServerSupervisionRequest,
    pub status: CodexAppServerSupervisionReadinessStatus,
    pub blockers: Vec<CodexAppServerSupervisionBlocker>,
}

/// Coarse Codex supervision readiness status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSupervisionReadinessStatus {
    Ready,
    Blocked,
}

/// Reason Codex app-server supervision is not ready.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSupervisionBlocker {
    MissingBinary,
    MissingAuth,
    MissingExecutionAuthority,
    UnsupportedProtocol,
    TransportNotReady,
    ProcessControlNotReady,
    RawProviderPayloadStorageRequested,
    LiveSpawnNotEnabled,
}
/// Assess Codex app-server supervision readiness without spawning.
pub fn assess_codex_app_server_supervision(
    input: CodexAppServerSupervisionReadinessInput,
) -> CodexAppServerSupervisionReadiness {
    let mut blockers = Vec::new();

    if !input.request.binary.available {
        blockers.push(CodexAppServerSupervisionBlocker::MissingBinary);
    }

    if input.auth_disposition != ClientAuthDisposition::Allowed {
        blockers.push(CodexAppServerSupervisionBlocker::MissingAuth);
    }

    let authority = input.authority_map.readiness_for(
        &input.request.execution_host_id,
        &ProjectAuthorityDomain::Execution,
    );
    if !authority.is_ready() {
        blockers.push(CodexAppServerSupervisionBlocker::MissingExecutionAuthority);
    }

    if input.protocol_profile.version != CLIENT_PROTOCOL_VERSION_V1
        || !input
            .protocol_profile
            .supports_message(crate::ClientProtocolMessageKind::ServerEvent)
    {
        blockers.push(CodexAppServerSupervisionBlocker::UnsupportedProtocol);
    }

    if input.local_transport.status != LocalTransportReadinessStatus::Ready {
        blockers.push(CodexAppServerSupervisionBlocker::TransportNotReady);
    }

    if !input.process_control.supports_future_spawn() {
        blockers.push(CodexAppServerSupervisionBlocker::ProcessControlNotReady);
    }

    if input
        .request
        .supervision_limits
        .allow_raw_provider_payload_storage
    {
        blockers.push(CodexAppServerSupervisionBlocker::RawProviderPayloadStorageRequested);
    }

    if !input.request.supervision_limits.allow_live_spawn {
        blockers.push(CodexAppServerSupervisionBlocker::LiveSpawnNotEnabled);
    }

    let status = if blockers.is_empty() {
        CodexAppServerSupervisionReadinessStatus::Ready
    } else {
        CodexAppServerSupervisionReadinessStatus::Blocked
    };

    CodexAppServerSupervisionReadiness {
        request: input.request,
        status,
        blockers,
    }
}
