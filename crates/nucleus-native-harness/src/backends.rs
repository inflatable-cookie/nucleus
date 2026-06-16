//! Native harness model backend records.

/// Stable native model backend id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct NativeModelBackendId(pub String);

/// Model backend available to native personas.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NativeModelBackend {
    pub id: NativeModelBackendId,
    pub kind: NativeModelBackendKind,
    pub display_name: String,
    pub local: bool,
}

/// Native model backend kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeModelBackendKind {
    LocalInferenceServer,
    RustInferenceLibrary,
    CloudModelRoute(String),
    Sidecar(String),
    NoneDeterministicOnly,
    Unknown,
}
