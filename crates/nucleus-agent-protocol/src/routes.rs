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

/// Scoped override applied to a base model route.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRouteOverride {
    pub override_id: String,
    pub base_route_id: String,
    pub scope: ModelRouteOverrideScope,
    pub effect: ModelRouteOverrideEffect,
    pub fields: Vec<ModelRouteOverrideField>,
    pub inheritance: ModelRouteInheritancePolicy,
    pub reason: Option<String>,
}

/// Scope where a model route override applies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelRouteOverrideScope {
    Project(String),
    Session(String),
    TaskPreference(String),
}

/// Whether an override affects adapter selection or only runtime config.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelRouteOverrideEffect {
    SelectionInput,
    RuntimeConfigOnly,
    DisableRouteInScope,
}

/// Field-level override for route metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelRouteOverrideField {
    Endpoint(RouteEndpoint),
    ModelId(String),
    AuthSource(AuthSource),
    BillingAccountSource(BillingAccountSource),
    Enabled(bool),
    FallbackPolicy(RoutePolicy),
    ProviderSelectionHints(Vec<String>),
    RegionalConstraints(Vec<String>),
}

/// Which base-route fields are inherited by a scoped override.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRouteInheritancePolicy {
    pub inherit_capabilities: bool,
    pub inherit_auth_source: bool,
    pub inherit_billing_account_source: bool,
    pub inherit_endpoint: bool,
    pub inherit_provider_selection_hints: bool,
}

/// Result of resolving a base route plus scoped overrides.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedModelRoute {
    pub base_route_id: String,
    pub applied_override_ids: Vec<String>,
    pub route: ModelRoute,
    pub selection_notes: Vec<String>,
}
