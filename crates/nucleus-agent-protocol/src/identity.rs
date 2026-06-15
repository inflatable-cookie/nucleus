//! Adapter identity and transport types.

/// Stable identity for a configured harness adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdapterIdentity {
    pub adapter_id: String,
    pub provider_driver_kind: ProviderDriverKind,
    pub provider_instance_id: String,
    pub provider_name: String,
    pub harness_name: String,
    pub transport_family: TransportFamily,
    pub version_discovery: VersionDiscovery,
    pub authentication_preflight: AuthenticationPreflight,
}

/// Implementation family for a provider integration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderDriverKind {
    Codex,
    Claude,
    CursorCli,
    CursorSdk,
    OpenCode,
    KimiCli,
    KimiAgentSdk,
    Pi,
    Other(String),
}

/// Transport used by an adapter instance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportFamily {
    Sdk,
    AcpStdio,
    AcpHttpWebSocket,
    WireStdio,
    RpcStdio,
    StructuredAppServerRuntime,
    ServerSdkOverHttp,
    CliTerminalBridge,
    CustomProviderBridge,
}

/// How an adapter discovers the upstream harness version.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VersionDiscovery {
    Unsupported,
    Command(String),
    ApiEndpoint(String),
    SdkMetadata,
    Static(String),
}

/// How an adapter checks auth/config before starting work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AuthenticationPreflight {
    Unsupported,
    Command(String),
    ApiEndpoint(String),
    Environment,
    ConfigFile,
    SdkCallback,
}
