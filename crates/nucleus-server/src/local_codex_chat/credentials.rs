use serde::{Deserialize, Serialize};

const PROVIDER_INSTANCE_ID: &str = "codex:local-default";
const ACCESS_PROFILE_REF: &str = "nucleus.codex.oauth";

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialMechanism {
    InteractiveOauth,
    DeviceOauth,
    ApiKey,
    AutomationToken,
    WorkloadIdentity,
    CloudProviderIdentity,
    GatewayHelper,
    Unauthenticated,
    LocalUnauthenticated,
    ProviderSpecific,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexEntitlementMetering {
    SubscriptionAllowance,
    PrepaidCredits,
    BundledCredits,
    PayAsYouGo,
    CloudAccountBilling,
    LocalCompute,
    Unknown,
    ProviderSpecific,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialOwnership {
    NucleusHost,
    ProviderManaged,
    ExternalManager,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialStatus {
    Unknown,
    Ready,
    Missing,
    Expired,
    Revoked,
    PermissionDenied,
    RequiresUserAction,
    Unsupported,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialEvidencePosture {
    CallerAsserted,
    HostObserved,
    ProviderObserved,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialAction {
    Setup,
    Repair,
    Revoke,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialActionAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialActionUnavailableReason {
    ProviderManagedLifecycle,
    MissingCredentialReference,
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCodexCredentialActionCapability {
    pub action: LocalCodexCredentialAction,
    pub availability: LocalCodexCredentialActionAvailability,
    pub unavailable_reason: Option<LocalCodexCredentialActionUnavailableReason>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCodexCredentialSummary {
    pub access_profile_ref: String,
    pub credential_ref: Option<String>,
    pub mechanism: LocalCodexCredentialMechanism,
    pub entitlement_metering: LocalCodexEntitlementMetering,
    pub ownership: LocalCodexCredentialOwnership,
    pub status: LocalCodexCredentialStatus,
    pub evidence_posture: LocalCodexCredentialEvidencePosture,
    pub actions: Vec<LocalCodexCredentialActionCapability>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCodexCredentialActionRequest {
    pub request_id: String,
    pub provider_instance_id: String,
    pub credential_ref: Option<String>,
    pub action: LocalCodexCredentialAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialActionOutcome {
    Completed,
    Unavailable,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalCodexCredentialActionCode {
    ProviderManagedLifecycle,
    MissingCredentialReference,
    ProviderMismatch,
    CredentialReferenceMismatch,
    InvalidRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LocalCodexCredentialActionReceipt {
    pub request_id: Option<String>,
    pub provider_instance_id: String,
    pub credential_ref: Option<String>,
    pub action: LocalCodexCredentialAction,
    pub outcome: LocalCodexCredentialActionOutcome,
    pub code: LocalCodexCredentialActionCode,
    pub changed: bool,
}

pub fn summary() -> LocalCodexCredentialSummary {
    LocalCodexCredentialSummary {
        access_profile_ref: ACCESS_PROFILE_REF.to_owned(),
        credential_ref: None,
        mechanism: LocalCodexCredentialMechanism::InteractiveOauth,
        entitlement_metering: LocalCodexEntitlementMetering::SubscriptionAllowance,
        ownership: LocalCodexCredentialOwnership::ProviderManaged,
        status: LocalCodexCredentialStatus::Ready,
        evidence_posture: LocalCodexCredentialEvidencePosture::CallerAsserted,
        actions: [
            LocalCodexCredentialAction::Setup,
            LocalCodexCredentialAction::Repair,
            LocalCodexCredentialAction::Revoke,
        ]
        .into_iter()
        .map(|action| LocalCodexCredentialActionCapability {
            action,
            availability: LocalCodexCredentialActionAvailability::Unavailable,
            unavailable_reason: Some(
                LocalCodexCredentialActionUnavailableReason::ProviderManagedLifecycle,
            ),
        })
        .collect(),
    }
}

pub fn request_action(
    request: LocalCodexCredentialActionRequest,
) -> LocalCodexCredentialActionReceipt {
    if !valid_id(&request.request_id) {
        return receipt(
            None,
            request.action,
            LocalCodexCredentialActionOutcome::Rejected,
            LocalCodexCredentialActionCode::InvalidRequest,
        );
    }
    if request.provider_instance_id != PROVIDER_INSTANCE_ID {
        return receipt(
            Some(request.request_id),
            request.action,
            LocalCodexCredentialActionOutcome::Rejected,
            LocalCodexCredentialActionCode::ProviderMismatch,
        );
    }
    if request.credential_ref.is_some() {
        return receipt(
            Some(request.request_id),
            request.action,
            LocalCodexCredentialActionOutcome::Rejected,
            LocalCodexCredentialActionCode::CredentialReferenceMismatch,
        );
    }
    receipt(
        Some(request.request_id),
        request.action,
        LocalCodexCredentialActionOutcome::Unavailable,
        LocalCodexCredentialActionCode::ProviderManagedLifecycle,
    )
}

fn receipt(
    request_id: Option<String>,
    action: LocalCodexCredentialAction,
    outcome: LocalCodexCredentialActionOutcome,
    code: LocalCodexCredentialActionCode,
) -> LocalCodexCredentialActionReceipt {
    LocalCodexCredentialActionReceipt {
        request_id,
        provider_instance_id: PROVIDER_INSTANCE_ID.to_owned(),
        credential_ref: None,
        action,
        outcome,
        code,
        changed: false,
    }
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, ':' | '-' | '_' | '.')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_keeps_oauth_subscription_and_provider_ownership_distinct() {
        let summary = summary();

        assert_eq!(summary.credential_ref, None);
        assert_eq!(
            summary.mechanism,
            LocalCodexCredentialMechanism::InteractiveOauth
        );
        assert_eq!(
            summary.entitlement_metering,
            LocalCodexEntitlementMetering::SubscriptionAllowance
        );
        assert_eq!(
            summary.ownership,
            LocalCodexCredentialOwnership::ProviderManaged
        );
        assert!(summary.actions.iter().all(|capability| {
            capability.availability == LocalCodexCredentialActionAvailability::Unavailable
        }));
    }

    #[test]
    fn provider_managed_revoke_is_explicit_and_has_no_effect() {
        let before = summary();
        let receipt = request_action(LocalCodexCredentialActionRequest {
            request_id: "credential-action:revoke:1".to_owned(),
            provider_instance_id: PROVIDER_INSTANCE_ID.to_owned(),
            credential_ref: None,
            action: LocalCodexCredentialAction::Revoke,
        });

        assert_eq!(
            receipt.outcome,
            LocalCodexCredentialActionOutcome::Unavailable
        );
        assert_eq!(
            receipt.code,
            LocalCodexCredentialActionCode::ProviderManagedLifecycle
        );
        assert!(!receipt.changed);
        assert_eq!(summary(), before);
    }

    #[test]
    fn mismatched_refs_fail_closed_without_echoing_them() {
        let receipt = request_action(LocalCodexCredentialActionRequest {
            request_id: "credential-action:repair:1".to_owned(),
            provider_instance_id: PROVIDER_INSTANCE_ID.to_owned(),
            credential_ref: Some("credential:other".to_owned()),
            action: LocalCodexCredentialAction::Repair,
        });

        assert_eq!(
            receipt.code,
            LocalCodexCredentialActionCode::CredentialReferenceMismatch
        );
        assert_eq!(receipt.credential_ref, None);
        assert!(!receipt.changed);
    }

    #[test]
    fn wire_request_rejects_secret_shaped_extra_fields() {
        let error =
            serde_json::from_value::<LocalCodexCredentialActionRequest>(serde_json::json!({
                "request_id": "credential-action:setup:1",
                "provider_instance_id": PROVIDER_INSTANCE_ID,
                "credential_ref": null,
                "action": "setup",
                "api_key": "must-not-cross-this-boundary"
            }))
            .unwrap_err();

        assert!(error.to_string().contains("unknown field"));
    }
}
