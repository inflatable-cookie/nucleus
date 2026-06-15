//! Model/provider route types.

use crate::capabilities::CapabilitySupport;

/// Stable route identity for model/provider routing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRoute {
    pub route_id: String,
    pub provider_id: String,
    pub display_name: String,
    pub compatibility_family: ApiCompatibilityFamily,
    pub endpoint: RouteEndpoint,
    pub model_id: String,
    pub auth_source: AuthSource,
    pub billing_account_source: BillingAccountSource,
    pub enabled: bool,
    pub capabilities: ModelRouteCapabilities,
}

/// API shape exposed by a model route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApiCompatibilityFamily {
    OpenAiCompatible,
    AnthropicCompatible,
    ProviderNative,
    GatewayRouter,
}

/// Addressing mode for a model route endpoint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RouteEndpoint {
    BaseUrl(String),
    ProviderEndpointId(String),
}

/// Where credentials are resolved for a model route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthSource {
    Environment(String),
    ConfigKey(String),
    SystemCredentialStore(String),
    ProviderManaged,
    Unknown,
}

/// Where account and billing ownership is resolved for a route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BillingAccountSource {
    SameAsAuth,
    ProviderAccount(String),
    GatewayAccount(String),
    Unknown,
}

/// Best-known model route capabilities.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRouteCapabilities {
    pub context_length: Option<u64>,
    pub max_output_tokens: Option<u64>,
    pub streaming: CapabilitySupport,
    pub tool_calls: CapabilitySupport,
    pub structured_output: CapabilitySupport,
    pub media_input: CapabilitySupport,
    pub reasoning_controls: CapabilitySupport,
    pub prompt_cache: CapabilitySupport,
    pub cache_retention: CapabilitySupport,
    pub parallel_tool_calls: CapabilitySupport,
    pub fallback_policy: RoutePolicy,
    pub provider_selection_hints: Vec<String>,
    pub regional_constraints: Vec<String>,
}

/// Routing policy exposed by a gateway or provider route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoutePolicy {
    SingleProvider,
    ProviderFallback,
    GatewayRouted,
    Unknown,
}
