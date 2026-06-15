//! Server deployment and access endpoint types.

/// How a nucleus server is deployed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeploymentMode {
    LocalOnly,
    LocalNetwork,
    InternetReachable,
    ManagedRemote,
}

/// Concrete way a client reaches a server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccessEndpoint {
    LocalSocket(String),
    LoopbackHttp(String),
    LanHttp(String),
    RemoteHttp(String),
    Custom(String),
}

/// Running server runtime identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerRuntime {
    pub deployment_mode: DeploymentMode,
    pub endpoint: AccessEndpoint,
    pub instance_id: String,
}
