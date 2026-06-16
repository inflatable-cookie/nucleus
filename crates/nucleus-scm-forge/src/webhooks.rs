//! Forge webhook verification boundary types.

use crate::auth::CredentialReferenceId;
use crate::ids::ForgeProviderRef;

/// Stable webhook endpoint id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct WebhookEndpointId(pub String);

/// Configured webhook verification policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebhookVerificationPolicy {
    pub endpoint_id: WebhookEndpointId,
    pub provider_ref: Option<ForgeProviderRef>,
    pub method: WebhookVerificationMethod,
    pub signing_secret_ref: Option<CredentialReferenceId>,
    pub replay_window_seconds: Option<u64>,
}

/// Webhook verification method.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebhookVerificationMethod {
    SharedSecretHmac,
    ProviderSignature,
    MutualTls,
    NetworkBoundaryOnly,
    DisabledForLocalDevelopment,
    Unsupported,
}

/// Sanitized webhook verification evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WebhookVerificationEvidence {
    pub endpoint_id: WebhookEndpointId,
    pub status: WebhookVerificationStatus,
    pub provider_event_ref: Option<ForgeProviderRef>,
    pub failure_kind: Option<WebhookVerificationFailureKind>,
    pub summary: Option<String>,
}

/// Webhook verification result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebhookVerificationStatus {
    Verified,
    Rejected,
    SkippedByPolicy,
    Unsupported,
    Unknown,
}

/// Sanitized webhook verification failure kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WebhookVerificationFailureKind {
    MissingSignature,
    InvalidSignature,
    MissingSecret,
    ExpiredTimestamp,
    ReplaySuspected,
    UnsupportedAlgorithm,
    MalformedPayload,
    Unknown,
}
