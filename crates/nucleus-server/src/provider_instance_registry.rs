//! Server-side provider instance registry records.
//!
//! These records describe configured provider instances and their evidence.
//! They do not contain credentials, hot reload behavior, or live runtime
//! handles.

use nucleus_agent_protocol::{
    AdapterCapabilities, AdapterIdentity, AdapterRuntimeOwnership, ProviderDriverKind,
};

use crate::provider_service_runtime::ProviderServiceId;

/// Stable id for a provider instance registry.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProviderInstanceRegistryId(pub String);

/// Stable id for one configured provider instance.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ConfiguredProviderInstanceId(pub String);

/// Registry of configured provider instances known by a server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderInstanceRegistryRecord {
    pub registry_id: ProviderInstanceRegistryId,
    pub instances: Vec<ConfiguredProviderInstanceRecord>,
}

/// Configured provider instance separated from provider driver kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfiguredProviderInstanceRecord {
    pub instance_id: ConfiguredProviderInstanceId,
    pub driver_kind: ProviderDriverKind,
    pub adapter: AdapterIdentity,
    pub display_name: String,
    pub capability_posture: ProviderCapabilityDiscoveryPosture,
    pub capabilities: AdapterCapabilities,
    pub auth_readiness: ProviderAuthReadiness,
    pub config_evidence_refs: Vec<ProviderConfigEvidenceRef>,
    pub runtime_ownership: AdapterRuntimeOwnership,
    pub service_id: Option<ProviderServiceId>,
    pub hot_reload_supported: bool,
}

/// How capability information was produced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderCapabilityDiscoveryPosture {
    StaticDescriptor,
    ProbeRequired,
    ProbeCurrent { evidence_ref: String },
    StaleProbe { evidence_ref: String },
    Unknown,
}

/// Auth readiness without credential material.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderAuthReadiness {
    Ready { evidence_ref: String },
    NeedsAuthentication,
    NeedsConfiguration(Vec<String>),
    Unsupported,
    Unknown,
}

/// Non-secret evidence reference for one provider config input.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderConfigEvidenceRef {
    pub key: String,
    pub scope: ProviderConfigScope,
    pub evidence_ref: String,
    pub contains_secret_material: bool,
}

/// Where a provider config evidence ref applies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderConfigScope {
    Driver,
    Instance,
    Project,
    Session,
}

/// Input for one configured provider instance record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfiguredProviderInstanceInput {
    pub instance_id: ConfiguredProviderInstanceId,
    pub adapter: AdapterIdentity,
    pub display_name: String,
    pub capability_posture: ProviderCapabilityDiscoveryPosture,
    pub capabilities: AdapterCapabilities,
    pub auth_readiness: ProviderAuthReadiness,
    pub config_evidence_refs: Vec<ProviderConfigEvidenceRef>,
    pub runtime_ownership: AdapterRuntimeOwnership,
    pub service_id: Option<ProviderServiceId>,
}

/// Provider registry record construction error.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderInstanceRegistryError {
    InstanceIdMatchesDriverKind {
        instance_id: ConfiguredProviderInstanceId,
        driver_kind: ProviderDriverKind,
    },
    SecretMaterialInConfigEvidence {
        key: String,
    },
}

/// Build a configured provider instance record without accepting secrets.
pub fn configured_provider_instance_record(
    input: ConfiguredProviderInstanceInput,
) -> Result<ConfiguredProviderInstanceRecord, ProviderInstanceRegistryError> {
    let expected = input.adapter.provider_driver_kind.clone();
    if input.instance_id.0 == provider_driver_kind_label(&expected) {
        return Err(ProviderInstanceRegistryError::InstanceIdMatchesDriverKind {
            instance_id: input.instance_id,
            driver_kind: input.adapter.provider_driver_kind,
        });
    }
    if let Some(secret_ref) = input
        .config_evidence_refs
        .iter()
        .find(|config_ref| config_ref.contains_secret_material)
    {
        return Err(
            ProviderInstanceRegistryError::SecretMaterialInConfigEvidence {
                key: secret_ref.key.clone(),
            },
        );
    }

    Ok(ConfiguredProviderInstanceRecord {
        instance_id: input.instance_id,
        driver_kind: input.adapter.provider_driver_kind.clone(),
        adapter: input.adapter,
        display_name: input.display_name,
        capability_posture: input.capability_posture,
        capabilities: input.capabilities,
        auth_readiness: input.auth_readiness,
        config_evidence_refs: input.config_evidence_refs,
        runtime_ownership: input.runtime_ownership,
        service_id: input.service_id,
        hot_reload_supported: false,
    })
}

fn provider_driver_kind_label(driver_kind: &ProviderDriverKind) -> String {
    match driver_kind {
        ProviderDriverKind::Codex => "codex",
        ProviderDriverKind::Claude => "claude",
        ProviderDriverKind::CursorCli => "cursor-cli",
        ProviderDriverKind::CursorSdk => "cursor-sdk",
        ProviderDriverKind::OpenCode => "opencode",
        ProviderDriverKind::KimiCli => "kimi-cli",
        ProviderDriverKind::KimiAgentSdk => "kimi-agent-sdk",
        ProviderDriverKind::Pi => "pi",
        ProviderDriverKind::Other(label) => label,
    }
    .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nucleus_agent_protocol::{
        AdapterRuntimeOwnershipMode, AuthenticationPreflight, BackpressureOverflow,
        BackpressurePolicy, CapabilitySupport, CommandAcknowledgementSemantics,
        CommandCompletionSemantics, CommandStreamSemantics, DisconnectSemantics,
        EventOrderingSemantics, EventStreamSemantics, RecoveryAction, RuntimeProcessOwner,
        RuntimeRecoveryPolicy, TransportFamily, VersionDiscovery,
    };

    #[test]
    fn provider_instance_record_separates_instance_from_driver_kind() {
        let record =
            configured_provider_instance_record(configured_codex_instance_input()).unwrap();

        assert_eq!(
            record.instance_id,
            ConfiguredProviderInstanceId("codex:local-default".to_owned())
        );
        assert_eq!(record.driver_kind, ProviderDriverKind::Codex);
        assert_ne!(record.instance_id.0, "codex");
        assert_eq!(
            record.capability_posture,
            ProviderCapabilityDiscoveryPosture::StaticDescriptor
        );
        assert!(matches!(
            record.auth_readiness,
            ProviderAuthReadiness::Ready { .. }
        ));
        assert!(!record.hot_reload_supported);
    }

    #[test]
    fn provider_instance_record_rejects_secret_config_evidence() {
        let mut input = configured_codex_instance_input();
        input.config_evidence_refs.push(ProviderConfigEvidenceRef {
            key: "api_key".to_owned(),
            scope: ProviderConfigScope::Instance,
            evidence_ref: "secret-value".to_owned(),
            contains_secret_material: true,
        });

        let error = configured_provider_instance_record(input).unwrap_err();

        assert_eq!(
            error,
            ProviderInstanceRegistryError::SecretMaterialInConfigEvidence {
                key: "api_key".to_owned()
            }
        );
    }

    #[test]
    fn provider_instance_id_cannot_be_only_driver_kind() {
        let mut input = configured_codex_instance_input();
        input.instance_id = ConfiguredProviderInstanceId("codex".to_owned());

        let error = configured_provider_instance_record(input).unwrap_err();

        assert!(matches!(
            error,
            ProviderInstanceRegistryError::InstanceIdMatchesDriverKind {
                instance_id: ConfiguredProviderInstanceId(_),
                driver_kind: ProviderDriverKind::Codex,
            }
        ));
    }

    fn configured_codex_instance_input() -> ConfiguredProviderInstanceInput {
        ConfiguredProviderInstanceInput {
            instance_id: ConfiguredProviderInstanceId("codex:local-default".to_owned()),
            adapter: codex_adapter(),
            display_name: "Local Codex".to_owned(),
            capability_posture: ProviderCapabilityDiscoveryPosture::StaticDescriptor,
            capabilities: codex_capabilities(),
            auth_readiness: ProviderAuthReadiness::Ready {
                evidence_ref: "evidence:codex-doctor".to_owned(),
            },
            config_evidence_refs: vec![ProviderConfigEvidenceRef {
                key: "binary".to_owned(),
                scope: ProviderConfigScope::Driver,
                evidence_ref: "evidence:codex-binary".to_owned(),
                contains_secret_material: false,
            }],
            runtime_ownership: codex_runtime_ownership(),
            service_id: Some(ProviderServiceId("provider-service:codex:local".to_owned())),
        }
    }

    fn codex_adapter() -> AdapterIdentity {
        AdapterIdentity {
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
        }
    }

    fn codex_capabilities() -> AdapterCapabilities {
        AdapterCapabilities {
            streaming_output: CapabilitySupport::Supported,
            tool_call_events: CapabilitySupport::Supported,
            file_edit_events: CapabilitySupport::Supported,
            permission_prompts: CapabilitySupport::Supported,
            cancellation: CapabilitySupport::Supported,
            checkpointing: CapabilitySupport::Partial(
                "provider checkpoints are not filesystem checkpoints".to_owned(),
            ),
            resume: CapabilitySupport::Supported,
            terminal_rendering: CapabilitySupport::Partial("CLI fallback only".to_owned()),
            structured_messages: CapabilitySupport::Supported,
            raw_transcript_access: CapabilitySupport::Partial(
                "metadata only until retention policy widens".to_owned(),
            ),
            model_switch: CapabilitySupport::Supported,
            account_config_preflight: CapabilitySupport::Supported,
            multi_instance: CapabilitySupport::Partial("profile isolation unproven".to_owned()),
            rollback: CapabilitySupport::Partial("provider rollback only".to_owned()),
            provider_native_session_resume: CapabilitySupport::Supported,
            external_server: CapabilitySupport::Supported,
            server_spawn: CapabilitySupport::Supported,
        }
    }

    fn codex_runtime_ownership() -> AdapterRuntimeOwnership {
        AdapterRuntimeOwnership {
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
        }
    }
}
