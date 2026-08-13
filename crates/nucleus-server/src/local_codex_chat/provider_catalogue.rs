//! Nucleus product projection of Swallowtail's configured provider catalogue.

use nucleus_agent_adapters::{AgentAdapterRegistry, RegisteredProviderInstanceCatalogue};
use serde::{Deserialize, Serialize};
use swallowtail_core::{
    CredentialMechanism, CredentialState, EndpointAuthorization, EntitlementMetering,
    EntitlementState, InstanceOwnership, RuntimeReadiness, SupportAuthority,
};
use swallowtail_runtime::{
    AccessEvidenceProvenance, ConfiguredProviderInstanceRecord,
    ConfiguredProviderInstanceSelectionReadiness, ConfiguredProviderModelCatalogueState,
};

use super::routing::CHAT_PROVIDER_INSTANCE_ID;
use super::{
    credentials, LocalCodexChatModelOption, LocalCodexChatReasoningOption,
    LocalCodexCredentialSummary,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentChatProviderCatalogue {
    pub instances: Vec<AgentChatProviderInstance>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentChatProviderInstance {
    pub provider_instance_id: String,
    pub instance_revision: String,
    pub runtime_adapter_id: String,
    pub driver_id: String,
    pub integration_family: String,
    pub transport_family: String,
    pub protocol_facade_id: String,
    pub display_name: String,
    pub harness_name: String,
    pub ownership: String,
    pub selection_readiness: String,
    pub credential_posture: AgentChatCredentialPosture,
    pub credential: Option<LocalCodexCredentialSummary>,
    pub model_catalogue_state: String,
    pub model_catalogue_diagnostic: Option<String>,
    pub models: Vec<LocalCodexChatModelOption>,
    /// Whether this route realizes consumer tool exchange (swallowtail
    /// contract 041 §Consumer Tool Exchange): the route carries
    /// consumer-declared dynamic tools to the provider. Only tool-capable
    /// routes may be designated as a project orchestrator (contract 033
    /// Orchestrator Designation Rule; 2026-08-13 realization matrix).
    pub tool_capable: bool,
    /// Why the route is not tool-capable, present exactly when
    /// `tool_capable` is false. Deny-by-default with the documented reason.
    pub tool_capable_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentChatCredentialPosture {
    pub profile_id: String,
    pub mechanism: String,
    pub credential_state: String,
    pub entitlement_metering: String,
    pub entitlement_state: String,
    pub endpoint_authorization: String,
    pub runtime_readiness: String,
    pub support_authority: String,
    pub evidence_provenance: String,
}

impl AgentChatProviderCatalogue {
    pub fn discover() -> Result<Self, String> {
        let registered =
            AgentAdapterRegistry::with_builtin_adapters().configured_provider_catalogue()?;
        Self::from_registered(&registered)
    }

    fn from_registered(registered: &RegisteredProviderInstanceCatalogue) -> Result<Self, String> {
        let instances = registered
            .catalogue()
            .instances()
            .map(|record| project_instance(registered, record))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Self { instances })
    }

    pub fn instance(&self, instance_id: &str) -> Option<&AgentChatProviderInstance> {
        self.instances
            .iter()
            .find(|instance| instance.provider_instance_id == instance_id)
    }

    pub fn sole_ready_instance(&self) -> Option<&AgentChatProviderInstance> {
        let mut ready = self
            .instances
            .iter()
            .filter(|instance| instance.selection_readiness == "ready");
        let instance = ready.next()?;
        ready.next().is_none().then_some(instance)
    }
}

/// Runtime adapter ids that realize consumer tool exchange under swallowtail
/// contract 041 (the 2026-08-13 realization matrix): Codex (`dynamicTools`,
/// proven by the nucleus `task_ledger` path). Anthropic Messages and DeepSeek
/// qualify at drafting time but are not registered in this repo yet; the
/// CLI/ACP routes (claude-agent, gemini, kimi, cursor, opencode, pi,
/// oh-my-pi) do not — their tools come from provider configuration, not the
/// transport. Deny-by-default for anything unlisted.
pub(crate) const TOOL_CAPABLE_RUNTIME_ADAPTER_IDS: &[&str] = &["codex-app-server"];

/// Whether a route realizes consumer tool exchange for orchestrator
/// designation (contract 033 Orchestrator Designation Rule).
pub(crate) fn route_supports_consumer_tools(runtime_adapter_id: &str) -> bool {
    TOOL_CAPABLE_RUNTIME_ADAPTER_IDS.contains(&runtime_adapter_id)
}

fn tool_capable_reason(runtime_adapter_id: &str) -> Option<String> {
    (!route_supports_consumer_tools(runtime_adapter_id)).then(|| {
        format!(
            "the {runtime_adapter_id} route does not realize consumer tool exchange \
             (swallowtail contract 041 §Consumer Tool Exchange); only Codex, Anthropic \
             Messages, and DeepSeek routes qualify at drafting time"
        )
    })
}

fn project_instance(
    registered: &RegisteredProviderInstanceCatalogue,
    record: &ConfiguredProviderInstanceRecord,
) -> Result<AgentChatProviderInstance, String> {
    let runtime_adapter_id = registered
        .runtime_adapter_id(record.instance_id())
        .ok_or_else(|| "configured provider instance has no Nucleus runtime binding".to_owned())?;
    let tool_capable = route_supports_consumer_tools(runtime_adapter_id);
    let model_catalogue = record.model_catalogue();
    let models = model_catalogue
        .into_iter()
        .flat_map(|catalogue| catalogue.entries())
        .map(|entry| {
            let metadata = entry.metadata();
            let reasoning = metadata.reasoning();
            LocalCodexChatModelOption {
                provider_id: entry.provider_id().map(|id| id.as_str().to_owned()),
                model: entry.id().as_str().to_owned(),
                display_name: metadata
                    .display_name()
                    .unwrap_or_else(|| entry.id().as_str())
                    .to_owned(),
                description: metadata.description().unwrap_or_default().to_owned(),
                default_reasoning_effort: reasoning
                    .and_then(|value| value.default_mode())
                    .map(|mode| mode.as_str().to_owned())
                    .unwrap_or_else(|| "low".to_owned()),
                supported_reasoning_efforts: reasoning
                    .map(|value| {
                        value
                            .supported_modes()
                            .map(|mode| LocalCodexChatReasoningOption {
                                reasoning_effort: mode.as_str().to_owned(),
                                description: String::new(),
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect();
    let posture = record.credential_posture();
    let (display_name, harness_name) = if record.instance_id().as_str() == CHAT_PROVIDER_INSTANCE_ID
    {
        ("Local Codex", "Codex app-server")
    } else {
        (
            record.instance_id().as_str(),
            record.driver_identity().id().as_str(),
        )
    };

    Ok(AgentChatProviderInstance {
        provider_instance_id: record.instance_id().as_str().to_owned(),
        instance_revision: record.instance_revision().as_str().to_owned(),
        runtime_adapter_id: runtime_adapter_id.to_owned(),
        driver_id: record.driver_identity().id().as_str().to_owned(),
        integration_family: record.integration_family().as_str().to_owned(),
        transport_family: record.transport_family().as_str().to_owned(),
        protocol_facade_id: record.protocol_facade_id().as_str().to_owned(),
        display_name: display_name.to_owned(),
        harness_name: harness_name.to_owned(),
        ownership: ownership(record.ownership()).to_owned(),
        selection_readiness: match record.selection_readiness() {
            ConfiguredProviderInstanceSelectionReadiness::Ready => "ready",
            ConfiguredProviderInstanceSelectionReadiness::NotReady => "not_ready",
        }
        .to_owned(),
        credential_posture: AgentChatCredentialPosture {
            profile_id: posture.profile_id().as_str().to_owned(),
            mechanism: credential_mechanism(posture.credential_mechanism()).to_owned(),
            credential_state: credential_state(posture.credential_state()).to_owned(),
            entitlement_metering: entitlement_metering(posture.entitlement_metering()).to_owned(),
            entitlement_state: entitlement_state(posture.entitlement_state()).to_owned(),
            endpoint_authorization: endpoint_authorization(posture.endpoint_authorization())
                .to_owned(),
            runtime_readiness: runtime_readiness(posture.runtime_readiness()).to_owned(),
            support_authority: support_authority(posture.support_authority()).to_owned(),
            evidence_provenance: match posture.provenance() {
                AccessEvidenceProvenance::Observed(_) => "observed",
                AccessEvidenceProvenance::CallerAsserted => "caller_asserted",
            }
            .to_owned(),
        },
        credential: (record.instance_id().as_str() == CHAT_PROVIDER_INSTANCE_ID)
            .then(credentials::summary),
        model_catalogue_state: match model_catalogue.map(|catalogue| catalogue.state()) {
            Some(ConfiguredProviderModelCatalogueState::Available) => "available",
            Some(ConfiguredProviderModelCatalogueState::Unavailable) | None => "unavailable",
        }
        .to_owned(),
        model_catalogue_diagnostic: model_catalogue
            .and_then(|catalogue| catalogue.unavailable_diagnostic())
            .map(ToString::to_string),
        models,
        tool_capable,
        tool_capable_reason: tool_capable_reason(runtime_adapter_id),
    })
}

fn ownership(value: InstanceOwnership) -> &'static str {
    match value {
        InstanceOwnership::ExternalAttached => "external_attached",
        InstanceOwnership::HostOwnedEphemeral => "host_owned_ephemeral",
        InstanceOwnership::HostOwnedPersistent => "host_owned_persistent",
    }
}

fn credential_mechanism(value: &CredentialMechanism) -> &'static str {
    match value {
        CredentialMechanism::InteractiveOauth => "interactive_oauth",
        CredentialMechanism::DeviceOauth => "device_oauth",
        CredentialMechanism::AutomationToken => "automation_token",
        CredentialMechanism::ApiKey => "api_key",
        CredentialMechanism::WorkloadIdentity => "workload_identity",
        CredentialMechanism::CloudProviderIdentity => "cloud_provider_identity",
        CredentialMechanism::GatewayHelper => "gateway_helper",
        CredentialMechanism::Unauthenticated => "unauthenticated",
        CredentialMechanism::LocalUnauthenticated => "local_unauthenticated",
        CredentialMechanism::ProviderSpecific(_) => "provider_specific",
    }
}

fn entitlement_metering(value: &EntitlementMetering) -> &'static str {
    match value {
        EntitlementMetering::SubscriptionAllowance => "subscription_allowance",
        EntitlementMetering::PrepaidCredits => "prepaid_credits",
        EntitlementMetering::BundledCredits => "bundled_credits",
        EntitlementMetering::PayAsYouGo => "pay_as_you_go",
        EntitlementMetering::CloudAccountBilling => "cloud_account_billing",
        EntitlementMetering::LocalCompute => "local_compute",
        EntitlementMetering::Unknown => "unknown",
        EntitlementMetering::ProviderSpecific(_) => "provider_specific",
    }
}

fn credential_state(value: CredentialState) -> &'static str {
    match value {
        CredentialState::NotRequired => "not_required",
        CredentialState::Unknown => "unknown",
        CredentialState::Required => "required",
        CredentialState::Ready => "ready",
        CredentialState::Expired => "expired",
        CredentialState::Rejected => "rejected",
    }
}

fn entitlement_state(value: EntitlementState) -> &'static str {
    match value {
        EntitlementState::Unknown => "unknown",
        EntitlementState::Available => "available",
        EntitlementState::Unavailable => "unavailable",
        EntitlementState::Exhausted => "exhausted",
        EntitlementState::Restricted => "restricted",
    }
}

fn endpoint_authorization(value: EndpointAuthorization) -> &'static str {
    match value {
        EndpointAuthorization::Unknown => "unknown",
        EndpointAuthorization::Allowed => "allowed",
        EndpointAuthorization::Denied => "denied",
    }
}

fn runtime_readiness(value: RuntimeReadiness) -> &'static str {
    match value {
        RuntimeReadiness::Unknown => "unknown",
        RuntimeReadiness::Ready => "ready",
        RuntimeReadiness::Degraded => "degraded",
        RuntimeReadiness::Unavailable => "unavailable",
    }
}

fn support_authority(value: SupportAuthority) -> &'static str {
    match value {
        SupportAuthority::ProviderSupported => "provider_supported",
        SupportAuthority::IntegrationMaintainerSupported => "integration_maintainer_supported",
        SupportAuthority::ExperimentalObserved => "experimental_observed",
        SupportAuthority::Prohibited => "prohibited",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_route_realizes_consumer_tool_exchange() {
        assert!(route_supports_consumer_tools("codex-app-server"));
        assert_eq!(tool_capable_reason("codex-app-server"), None);
    }

    #[test]
    fn cli_and_acp_routes_are_refused_with_the_reason() {
        // The 2026-08-13 realization matrix: CLI/ACP routes take tools from
        // provider configuration, not the transport, so they cannot carry
        // the delegation verbs (contract 033: designation requires a
        // tool-capable route).
        for adapter_id in [
            "claude-agent",
            "gemini",
            "kimi",
            "cursor",
            "opencode",
            "pi",
            "oh-my-pi",
        ] {
            assert!(
                !route_supports_consumer_tools(adapter_id),
                "route {adapter_id} must not realize consumer tools"
            );
            let reason = tool_capable_reason(adapter_id).expect("refusal reason");
            assert!(
                reason.contains("does not realize consumer tool exchange"),
                "reason for {adapter_id}: {reason}"
            );
            assert!(reason.contains("contract 041"));
        }
    }

    #[test]
    fn unknown_routes_deny_by_default() {
        assert!(!route_supports_consumer_tools("adapter:not-registered"));
        assert!(tool_capable_reason("adapter:not-registered").is_some());
    }
}
