//! Provider retention policy records.
//!
//! These records validate provider payload, stream, and artifact retention at
//! record boundaries. They expose policy blockers, not raw provider material.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRetentionPolicyInput {
    pub record_ref: String,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub raw_payload_present: bool,
    pub raw_stream_present: bool,
    pub secret_material_present: bool,
    pub credential_material_present: bool,
    pub unbounded_local_path_present: bool,
    pub artifact_policy_approved: bool,
    pub diagnostics_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderRetentionPolicyRecord {
    pub policy_id: String,
    pub record_ref: String,
    pub status: ProviderRetentionPolicyStatus,
    pub blockers: Vec<ProviderRetentionPolicyBlocker>,
    pub evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub raw_payload_retained: bool,
    pub raw_stream_retained: bool,
    pub secret_material_retained: bool,
    pub credential_material_retained: bool,
    pub unbounded_local_path_retained: bool,
    pub approved_artifacts_reference_only: bool,
    pub diagnostics_summary: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetentionPolicyStatus {
    AcceptedReferenceOnly,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRetentionPolicyBlocker {
    MissingRecordRef,
    MissingEvidenceRef,
    EmptyRef,
    RawPayloadPresent,
    RawStreamPresent,
    SecretMaterialPresent,
    CredentialMaterialPresent,
    UnboundedLocalPathPresent,
    ArtifactPolicyMissing,
}

pub fn provider_retention_policy(
    input: ProviderRetentionPolicyInput,
) -> ProviderRetentionPolicyRecord {
    let blockers = blockers(&input);
    let status = if blockers.is_empty() {
        ProviderRetentionPolicyStatus::AcceptedReferenceOnly
    } else {
        ProviderRetentionPolicyStatus::Blocked
    };

    ProviderRetentionPolicyRecord {
        policy_id: format!("provider-retention-policy:{}", input.record_ref),
        record_ref: input.record_ref,
        status,
        blockers: blockers.clone(),
        evidence_refs: unique_sorted(input.evidence_refs),
        artifact_refs: unique_sorted(input.artifact_refs),
        raw_payload_retained: false,
        raw_stream_retained: false,
        secret_material_retained: false,
        credential_material_retained: false,
        unbounded_local_path_retained: false,
        approved_artifacts_reference_only: blockers.is_empty(),
        diagnostics_summary: input
            .diagnostics_requested
            .then(|| diagnostics_summary(&blockers)),
    }
}

fn blockers(input: &ProviderRetentionPolicyInput) -> Vec<ProviderRetentionPolicyBlocker> {
    let mut blockers = Vec::new();

    if input.record_ref.trim().is_empty() {
        blockers.push(ProviderRetentionPolicyBlocker::MissingRecordRef);
    }
    if input.evidence_refs.is_empty() {
        blockers.push(ProviderRetentionPolicyBlocker::MissingEvidenceRef);
    }
    if input
        .evidence_refs
        .iter()
        .chain(input.artifact_refs.iter())
        .any(|value| value.trim().is_empty())
    {
        blockers.push(ProviderRetentionPolicyBlocker::EmptyRef);
    }
    if input.raw_payload_present {
        blockers.push(ProviderRetentionPolicyBlocker::RawPayloadPresent);
    }
    if input.raw_stream_present {
        blockers.push(ProviderRetentionPolicyBlocker::RawStreamPresent);
    }
    if input.secret_material_present {
        blockers.push(ProviderRetentionPolicyBlocker::SecretMaterialPresent);
    }
    if input.credential_material_present {
        blockers.push(ProviderRetentionPolicyBlocker::CredentialMaterialPresent);
    }
    if input.unbounded_local_path_present {
        blockers.push(ProviderRetentionPolicyBlocker::UnboundedLocalPathPresent);
    }
    if !input.artifact_refs.is_empty() && !input.artifact_policy_approved {
        blockers.push(ProviderRetentionPolicyBlocker::ArtifactPolicyMissing);
    }

    blockers
}

fn diagnostics_summary(blockers: &[ProviderRetentionPolicyBlocker]) -> String {
    if blockers.is_empty() {
        return "provider retention accepted as reference-only".to_owned();
    }

    format!("provider retention blocked: {blockers:?}")
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_retention_policy_accepts_reference_only_artifacts() {
        let record = provider_retention_policy(input());

        assert_eq!(
            record.status,
            ProviderRetentionPolicyStatus::AcceptedReferenceOnly
        );
        assert!(record.approved_artifacts_reference_only);
        assert!(!record.raw_payload_retained);
        assert!(!record.raw_stream_retained);
    }

    #[test]
    fn provider_retention_policy_rejects_forbidden_retention_consistently() {
        let mut input = input();
        input.raw_payload_present = true;
        input.raw_stream_present = true;
        input.secret_material_present = true;
        input.credential_material_present = true;
        input.unbounded_local_path_present = true;

        let record = provider_retention_policy(input);

        assert_eq!(record.status, ProviderRetentionPolicyStatus::Blocked);
        assert!(record
            .blockers
            .contains(&ProviderRetentionPolicyBlocker::RawPayloadPresent));
        assert!(record
            .blockers
            .contains(&ProviderRetentionPolicyBlocker::RawStreamPresent));
        assert!(record
            .blockers
            .contains(&ProviderRetentionPolicyBlocker::CredentialMaterialPresent));
        assert!(!record.raw_payload_retained);
    }

    #[test]
    fn provider_retention_policy_diagnostics_expose_blockers_not_material() {
        let mut input = input();
        input.raw_payload_present = true;
        input.diagnostics_requested = true;

        let record = provider_retention_policy(input);
        let diagnostics = record.diagnostics_summary.expect("diagnostics");

        assert!(diagnostics.contains("RawPayloadPresent"));
        assert!(!diagnostics.contains("secret-value"));
        assert!(!diagnostics.contains("raw provider payload"));
    }

    fn input() -> ProviderRetentionPolicyInput {
        ProviderRetentionPolicyInput {
            record_ref: "provider-record:1".to_owned(),
            evidence_refs: vec!["evidence:retention:1".to_owned()],
            artifact_refs: vec!["artifact:summary:1".to_owned()],
            raw_payload_present: false,
            raw_stream_present: false,
            secret_material_present: false,
            credential_material_present: false,
            unbounded_local_path_present: false,
            artifact_policy_approved: true,
            diagnostics_requested: false,
        }
    }
}
