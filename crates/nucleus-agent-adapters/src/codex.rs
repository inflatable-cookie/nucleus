//! Metadata-only Codex app-server adapter descriptors.

use nucleus_agent_protocol::{
    AdapterCapabilities, AdapterIdentity, AdapterRuntimeOwnership, AdapterRuntimeOwnershipMode,
    AuthenticationPreflight, BackpressureOverflow, BackpressurePolicy, CapabilitySupport,
    CommandAcknowledgementSemantics, CommandCompletionSemantics, CommandStreamSemantics,
    DisconnectSemantics, EventOrderingSemantics, EventStreamSemantics, ModelRoute,
    ProviderDriverKind, RecoveryAction, RuntimeProcessOwner, RuntimeRecoveryPolicy,
    TransportFamily, VersionDiscovery,
};

use crate::config::{AdapterConfigEntry, AdapterConfigScope, AdapterConfigValue};
use crate::probes::{
    AdapterProbeCadence, AdapterProbeFailurePolicy, AdapterProbeKind, AdapterProbePolicy,
    AdapterProbeRequirement, AdapterProbeTarget, AdapterReadinessGate, AdapterStaleStatePolicy,
    AdapterStateAuthority,
};
use crate::registry::{AdapterInstanceRecord, AdapterRegistry, AdapterRegistryId};
use crate::selection::AdapterInstanceId;
use crate::status::{AdapterHealth, AdapterHealthStatus, AdapterLifecycleStatus, AdapterReadiness};

/// Current Codex app-server schema evidence used by the descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerSchemaEvidence {
    pub codex_version: String,
    pub probed_at_label: String,
    pub generated_json_schema: bool,
    pub generated_ts_bindings: bool,
}

/// Whitelisted Codex app-server method subset for the first implementation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerMethodSet {
    pub client_requests: Vec<String>,
    pub server_notifications: Vec<String>,
    pub server_requests: Vec<String>,
    pub experimental_server_requests: Vec<String>,
    pub deprecated_server_requests: Vec<String>,
}

/// Metadata-only Codex app-server descriptor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodexAppServerDescriptor {
    pub instance: AdapterInstanceRecord,
    pub schema_evidence: CodexAppServerSchemaEvidence,
    pub method_set: CodexAppServerMethodSet,
}

pub fn codex_app_server_descriptor() -> CodexAppServerDescriptor {
    CodexAppServerDescriptor {
        instance: codex_app_server_instance_record(),
        schema_evidence: CodexAppServerSchemaEvidence {
            codex_version: "codex-cli 0.140.0".to_owned(),
            probed_at_label: "2026-06-17".to_owned(),
            generated_json_schema: true,
            generated_ts_bindings: true,
        },
        method_set: CodexAppServerMethodSet {
            client_requests: vec![
                "initialize",
                "thread/start",
                "thread/resume",
                "thread/fork",
                "thread/read",
                "thread/rollback",
                "thread/list",
                "thread/loaded/list",
                "thread/unsubscribe",
                "turn/start",
                "turn/steer",
                "turn/interrupt",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            server_notifications: vec![
                "thread/started",
                "thread/status/changed",
                "thread/closed",
                "thread/tokenUsage/updated",
                "turn/started",
                "turn/completed",
                "turn/diff/updated",
                "turn/plan/updated",
                "item/started",
                "item/completed",
                "item/agentMessage/delta",
                "item/plan/delta",
                "item/commandExecution/outputDelta",
                "item/fileChange/outputDelta",
                "item/fileChange/patchUpdated",
                "serverRequest/resolved",
                "item/reasoning/summaryTextDelta",
                "item/reasoning/textDelta",
                "warning",
                "error",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            server_requests: vec![
                "item/commandExecution/requestApproval",
                "item/fileChange/requestApproval",
                "mcpServer/elicitation/request",
                "item/permissions/requestApproval",
                "item/tool/call",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            experimental_server_requests: vec!["item/tool/requestUserInput".to_owned()],
            deprecated_server_requests: vec![
                "applyPatchApproval".to_owned(),
                "execCommandApproval".to_owned(),
            ],
        },
    }
}

pub fn codex_app_server_registry() -> AdapterRegistry {
    AdapterRegistry {
        id: AdapterRegistryId("adapter-registry:default".to_owned()),
        instances: vec![codex_app_server_instance_record()],
    }
}

fn codex_app_server_instance_record() -> AdapterInstanceRecord {
    AdapterInstanceRecord {
        id: AdapterInstanceId("adapter:codex-app-server".to_owned()),
        identity: AdapterIdentity {
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
        capabilities: AdapterCapabilities {
            streaming_output: CapabilitySupport::Supported,
            tool_call_events: CapabilitySupport::Supported,
            file_edit_events: CapabilitySupport::Supported,
            permission_prompts: CapabilitySupport::Supported,
            cancellation: CapabilitySupport::Supported,
            checkpointing: CapabilitySupport::Partial(
                "thread/fork and thread/rollback exist; filesystem checkpoints remain separate"
                    .to_owned(),
            ),
            resume: CapabilitySupport::Supported,
            terminal_rendering: CapabilitySupport::Partial(
                "CLI/TUI fallback only; not the structured event source".to_owned(),
            ),
            structured_messages: CapabilitySupport::Supported,
            raw_transcript_access: CapabilitySupport::Partial(
                "thread/read and turn lists are available; retained payload policy is separate"
                    .to_owned(),
            ),
            model_switch: CapabilitySupport::Supported,
            account_config_preflight: CapabilitySupport::Partial(
                "version and doctor probes are metadata only until runtime probing exists"
                    .to_owned(),
            ),
            multi_instance: CapabilitySupport::Partial(
                "CODEX_HOME/profile behavior needs implementation proof".to_owned(),
            ),
            rollback: CapabilitySupport::Partial(
                "provider rollback is lossy and not filesystem rollback".to_owned(),
            ),
            provider_native_session_resume: CapabilitySupport::Supported,
            external_server: CapabilitySupport::Supported,
            server_spawn: CapabilitySupport::Supported,
        },
        config: vec![
            AdapterConfigEntry {
                key: "binary".to_owned(),
                value: AdapterConfigValue::String("codex".to_owned()),
                scope: AdapterConfigScope::Driver,
            },
            AdapterConfigEntry {
                key: "app_server.listen".to_owned(),
                value: AdapterConfigValue::String("stdio://".to_owned()),
                scope: AdapterConfigScope::Instance,
            },
            AdapterConfigEntry {
                key: "schema.probed_at".to_owned(),
                value: AdapterConfigValue::String("2026-06-17".to_owned()),
                scope: AdapterConfigScope::Driver,
            },
        ],
        model_routes: Vec::<ModelRoute>::new(),
        runtime_ownership: AdapterRuntimeOwnership {
            mode: AdapterRuntimeOwnershipMode::NucleusOwnedLocalServer,
            process_owner: RuntimeProcessOwner::Nucleus,
            endpoint_label: Some("stdio://".to_owned()),
            command_stream: CommandStreamSemantics {
                acknowledgement: CommandAcknowledgementSemantics::ProviderRequestId,
                completion: CommandCompletionSemantics::RuntimeEvent,
                backpressure: BackpressurePolicy {
                    bounded_capacity: None,
                    overflow: BackpressureOverflow::RejectNewCommands,
                },
            },
            event_stream: EventStreamSemantics {
                ordering: EventOrderingSemantics::TotalPerSession,
                disconnect: DisconnectSemantics::ProcessExitStatus,
                backpressure: BackpressurePolicy {
                    bounded_capacity: None,
                    overflow: BackpressureOverflow::DisconnectAndRecover,
                },
            },
            recovery_policy: RuntimeRecoveryPolicy {
                on_disconnect: RecoveryAction::RespawnOwnedRuntime,
                on_restart: RecoveryAction::ReattachSession,
            },
        },
        probe_policy: codex_app_server_probe_policy(),
        readiness: AdapterReadiness::Unknown,
        lifecycle_status: AdapterLifecycleStatus::Registered,
        health: AdapterHealth {
            status: AdapterHealthStatus::Unknown,
            checked_at_label: None,
            message: Some("metadata descriptor only; probes have not run".to_owned()),
        },
    }
}

fn codex_app_server_probe_policy() -> AdapterProbePolicy {
    AdapterProbePolicy {
        requirements: vec![
            AdapterProbeRequirement {
                kind: AdapterProbeKind::VersionDiscovery,
                target: AdapterProbeTarget::NucleusOwnedLocalServer,
                cadence: AdapterProbeCadence::OnServerStartup,
                required_before_work: true,
                stale_after_label: Some("server restart".to_owned()),
                failure_policy: AdapterProbeFailurePolicy {
                    health_status: AdapterHealthStatus::Error,
                    readiness: AdapterReadiness::NeedsConfiguration(vec![
                        "codex binary unavailable".to_owned(),
                    ]),
                    retain_stale_display_state: true,
                },
            },
            AdapterProbeRequirement {
                kind: AdapterProbeKind::StdioHandshake,
                target: AdapterProbeTarget::NucleusOwnedLocalServer,
                cadence: AdapterProbeCadence::BeforeAssignment,
                required_before_work: true,
                stale_after_label: Some("runtime transition".to_owned()),
                failure_policy: AdapterProbeFailurePolicy {
                    health_status: AdapterHealthStatus::Error,
                    readiness: AdapterReadiness::NeedsConfiguration(vec![
                        "codex app-server stdio handshake failed".to_owned(),
                    ]),
                    retain_stale_display_state: true,
                },
            },
            AdapterProbeRequirement {
                kind: AdapterProbeKind::AuthenticationPreflight,
                target: AdapterProbeTarget::NucleusOwnedLocalServer,
                cadence: AdapterProbeCadence::BeforeAssignment,
                required_before_work: true,
                stale_after_label: Some("auth state change".to_owned()),
                failure_policy: AdapterProbeFailurePolicy {
                    health_status: AdapterHealthStatus::Warning,
                    readiness: AdapterReadiness::NeedsAuthentication,
                    retain_stale_display_state: true,
                },
            },
        ],
        readiness_gate: AdapterReadinessGate {
            required_probe_kinds: vec![
                AdapterProbeKind::VersionDiscovery,
                AdapterProbeKind::StdioHandshake,
                AdapterProbeKind::AuthenticationPreflight,
            ],
            stale_health_blocks_work: true,
            terminal_fallback_allowed: true,
        },
        stale_state_policy: AdapterStaleStatePolicy {
            restored_health_authority: AdapterStateAuthority::StaleDisplayOnly,
            restored_readiness_authority: AdapterStateAuthority::FreshProbeRequired,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_descriptor_is_metadata_only_and_structured_runtime_first() {
        let descriptor = codex_app_server_descriptor();

        assert_eq!(
            descriptor.instance.identity.provider_driver_kind,
            ProviderDriverKind::Codex
        );
        assert_eq!(
            descriptor.instance.identity.transport_family,
            TransportFamily::StructuredAppServerRuntime
        );
        assert_eq!(
            descriptor.instance.runtime_ownership.mode,
            AdapterRuntimeOwnershipMode::NucleusOwnedLocalServer
        );
        assert_eq!(
            descriptor
                .instance
                .runtime_ownership
                .endpoint_label
                .as_deref(),
            Some("stdio://")
        );
        assert_eq!(descriptor.instance.readiness, AdapterReadiness::Unknown);
    }

    #[test]
    fn codex_descriptor_carries_schema_evidence_and_method_subset() {
        let descriptor = codex_app_server_descriptor();

        assert_eq!(
            descriptor.schema_evidence.codex_version,
            "codex-cli 0.140.0"
        );
        assert!(descriptor.schema_evidence.generated_json_schema);
        assert!(descriptor
            .method_set
            .client_requests
            .contains(&"thread/start".to_owned()));
        assert!(descriptor
            .method_set
            .client_requests
            .contains(&"turn/interrupt".to_owned()));
        assert!(descriptor
            .method_set
            .server_requests
            .contains(&"item/commandExecution/requestApproval".to_owned()));
        assert!(descriptor
            .method_set
            .experimental_server_requests
            .contains(&"item/tool/requestUserInput".to_owned()));
    }

    #[test]
    fn codex_registry_lists_descriptor_without_secret_material() {
        let registry = codex_app_server_registry();
        let instance = registry
            .instances
            .iter()
            .find(|instance| {
                instance.id == AdapterInstanceId("adapter:codex-app-server".to_owned())
            })
            .expect("codex app-server descriptor");

        assert_eq!(registry.instances.len(), 1);
        assert!(instance
            .probe_policy
            .readiness_gate
            .required_probe_kinds
            .contains(&AdapterProbeKind::StdioHandshake));
        assert!(instance
            .config
            .iter()
            .all(|entry| !matches!(entry.value, AdapterConfigValue::SecretRef(_))));
    }
}
