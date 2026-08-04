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

use super::{
    credentials, LocalCodexChatModelOption, LocalCodexChatReasoningOption,
    LocalCodexCredentialSummary, CHAT_PROVIDER_INSTANCE_ID,
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

fn project_instance(
    registered: &RegisteredProviderInstanceCatalogue,
    record: &ConfiguredProviderInstanceRecord,
) -> Result<AgentChatProviderInstance, String> {
    let runtime_adapter_id = registered
        .runtime_adapter_id(record.instance_id())
        .ok_or_else(|| "configured provider instance has no Nucleus runtime binding".to_owned())?;
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
