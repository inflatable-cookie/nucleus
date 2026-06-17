//! Client protocol profile records.
//!
//! These records describe the versioned protocol shape shared by local,
//! sidecar, and future remote clients. They do not implement a transport,
//! event bus, subscription channel, auth mechanism, or authority-map mutation.

mod authority_map;
mod host_capability;
mod profile;

pub use authority_map::{
    ProjectAuthorityDomainPublication, ProjectAuthorityMapPublicationRecord,
    ProjectAuthorityPublicationState, ProjectAuthorityValidationIssue,
};
pub use host_capability::{
    HostAuthorityMapPublication, HostCapabilityAdvertisement, HostCapabilityAdvertisementStatus,
    HostCapabilityCategory, HostCapabilityReadinessRef, HostCapabilityReadinessStatus,
    HostConnectionMode, HostRuntimeReadinessPublication,
};
pub use profile::{
    ClientProtocolAuthority, ClientProtocolCompatibility, ClientProtocolEnvelopeField,
    ClientProtocolMessageKind, ClientProtocolMessageShape, ClientProtocolProfile,
    ClientProtocolReadiness, ClientProtocolReadinessBlocker, ClientProtocolReadinessStatus,
    CLIENT_PROTOCOL_FAMILY, CLIENT_PROTOCOL_VERSION_V1,
};

#[cfg(test)]
mod tests;
