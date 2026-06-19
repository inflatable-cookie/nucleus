//! Codex app-server spawn-intent admission records.
//!
//! Spawn intent records compose readiness evidence. They do not spawn Codex or
//! allocate process handles.

use super::readiness::{
    CodexAppServerSupervisionBlocker, CodexAppServerSupervisionReadiness,
    CodexAppServerSupervisionReadinessStatus,
};
use super::runtime_instance::{
    CodexAppServerRuntimeInstanceRecord, CodexAppServerRuntimeInstanceState,
};

/// Stable id for one Codex spawn-intent admission.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CodexAppServerSpawnIntentId(pub String);

/// Admission record for a future Codex process spawn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSpawnIntentAdmission {
    pub intent_id: CodexAppServerSpawnIntentId,
    pub runtime_instance_id: String,
    pub status: CodexAppServerSpawnIntentAdmissionStatus,
    pub blockers: Vec<CodexAppServerSupervisionBlocker>,
    pub spawn_started: bool,
    pub evidence_refs: Vec<String>,
}

/// Spawn-intent admission status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CodexAppServerSpawnIntentAdmissionStatus {
    Accepted,
    Blocked(String),
}

/// Admit or block spawn intent from the current runtime instance and readiness
/// record.
pub fn admit_codex_spawn_intent(
    runtime: &CodexAppServerRuntimeInstanceRecord,
    readiness: &CodexAppServerSupervisionReadiness,
) -> CodexAppServerSpawnIntentAdmission {
    let mut blockers = readiness.blockers.clone();
    if !matches!(
        runtime.state,
        CodexAppServerRuntimeInstanceState::ReadyForSpawn
    ) {
        blockers.push(CodexAppServerSupervisionBlocker::LiveSpawnNotEnabled);
    }

    let status = if readiness.status == CodexAppServerSupervisionReadinessStatus::Ready
        && blockers.is_empty()
    {
        CodexAppServerSpawnIntentAdmissionStatus::Accepted
    } else {
        CodexAppServerSpawnIntentAdmissionStatus::Blocked(blocker_summary(&blockers))
    };

    CodexAppServerSpawnIntentAdmission {
        intent_id: CodexAppServerSpawnIntentId(format!(
            "codex-spawn-intent:{}",
            runtime.runtime_instance_id.0
        )),
        runtime_instance_id: runtime.runtime_instance_id.0.clone(),
        status,
        blockers,
        spawn_started: false,
        evidence_refs: runtime.evidence_refs.clone(),
    }
}

fn blocker_summary(blockers: &[CodexAppServerSupervisionBlocker]) -> String {
    if blockers.is_empty() {
        return "runtime instance is not ready for spawn".to_owned();
    }
    blockers
        .iter()
        .map(|blocker| format!("{blocker:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_supervision::{
        codex_runtime_instance_from_supervision_request, CodexAppServerBinary,
        CodexAppServerSchemaEvidenceRef, CodexAppServerSupervisionLimits,
        CodexAppServerSupervisionRequest,
    };
    use crate::host_authority::EngineHostId;
    use nucleus_agent_protocol::{
        AdapterIdentity, AuthenticationPreflight, ProviderDriverKind, TransportFamily,
        VersionDiscovery,
    };
    use nucleus_projects::ProjectId;

    fn runtime(state: CodexAppServerRuntimeInstanceState) -> CodexAppServerRuntimeInstanceRecord {
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
        codex_runtime_instance_from_supervision_request(&request, state)
    }

    fn readiness(
        status: CodexAppServerSupervisionReadinessStatus,
        blockers: Vec<CodexAppServerSupervisionBlocker>,
    ) -> CodexAppServerSupervisionReadiness {
        let request = CodexAppServerSupervisionRequest {
            project_id: ProjectId("project:1".to_owned()),
            execution_host_id: EngineHostId("host:local".to_owned()),
            adapter: runtime(CodexAppServerRuntimeInstanceState::ReadyForSpawn).adapter,
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
        CodexAppServerSupervisionReadiness {
            request,
            status,
            blockers,
        }
    }

    #[test]
    fn spawn_intent_accepts_ready_runtime_without_spawning() {
        let admission = admit_codex_spawn_intent(
            &runtime(CodexAppServerRuntimeInstanceState::ReadyForSpawn),
            &readiness(CodexAppServerSupervisionReadinessStatus::Ready, Vec::new()),
        );

        assert_eq!(
            admission.status,
            CodexAppServerSpawnIntentAdmissionStatus::Accepted
        );
        assert!(!admission.spawn_started);
        assert_eq!(
            admission.evidence_refs,
            vec!["evidence:codex-schema".to_owned()]
        );
    }

    #[test]
    fn spawn_intent_blocks_when_readiness_has_blockers() {
        let admission = admit_codex_spawn_intent(
            &runtime(CodexAppServerRuntimeInstanceState::ReadyForSpawn),
            &readiness(
                CodexAppServerSupervisionReadinessStatus::Blocked,
                vec![CodexAppServerSupervisionBlocker::MissingAuth],
            ),
        );

        assert!(matches!(
            admission.status,
            CodexAppServerSpawnIntentAdmissionStatus::Blocked(_)
        ));
        assert_eq!(
            admission.blockers,
            vec![CodexAppServerSupervisionBlocker::MissingAuth]
        );
        assert!(!admission.spawn_started);
    }

    #[test]
    fn spawn_intent_blocks_when_runtime_instance_is_not_ready() {
        let admission = admit_codex_spawn_intent(
            &runtime(CodexAppServerRuntimeInstanceState::Planned),
            &readiness(CodexAppServerSupervisionReadinessStatus::Ready, Vec::new()),
        );

        assert!(matches!(
            admission.status,
            CodexAppServerSpawnIntentAdmissionStatus::Blocked(_)
        ));
        assert!(admission
            .blockers
            .contains(&CodexAppServerSupervisionBlocker::LiveSpawnNotEnabled));
        assert!(!admission.spawn_started);
    }
}
