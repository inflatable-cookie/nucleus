//! Provider health summaries for doctor-facing evidence.
//!
//! These summaries are read-only and reference existing diagnostics evidence.

use serde::{Deserialize, Serialize};

use crate::{
    ProviderBackpressureSummaryRecord, ProviderRetentionPolicyRecord, ProviderRuntimeRepairRecord,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderHealthSummaryRecord {
    pub summary_id: String,
    pub status: ProviderHealthStatus,
    pub evidence_refs: Vec<String>,
    pub doctor_hint: String,
    pub provider_effect_executed: bool,
    pub raw_provider_material_retained: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderHealthStatus {
    Healthy,
    Watch,
    RepairRequired,
    Blocked,
}

pub fn provider_health_summary(
    provider_instance_id: String,
    repairs: &[ProviderRuntimeRepairRecord],
    backpressure: &[ProviderBackpressureSummaryRecord],
    retention: &[ProviderRetentionPolicyRecord],
) -> ProviderHealthSummaryRecord {
    let retention_blockers = retention
        .iter()
        .filter(|record| !record.blockers.is_empty())
        .count();
    let status = if retention_blockers > 0 {
        ProviderHealthStatus::Blocked
    } else if !repairs.is_empty() {
        ProviderHealthStatus::RepairRequired
    } else if !backpressure.is_empty() {
        ProviderHealthStatus::Watch
    } else {
        ProviderHealthStatus::Healthy
    };
    let mut evidence_refs = Vec::new();
    evidence_refs.extend(
        repairs
            .iter()
            .flat_map(|record| record.evidence_refs.clone()),
    );
    evidence_refs.extend(
        backpressure
            .iter()
            .flat_map(|record| record.evidence_refs.clone()),
    );
    evidence_refs.extend(
        retention
            .iter()
            .flat_map(|record| record.evidence_refs.clone()),
    );

    ProviderHealthSummaryRecord {
        summary_id: format!("provider-health-summary:{provider_instance_id}"),
        doctor_hint: doctor_hint(&status),
        status,
        evidence_refs: unique_sorted(evidence_refs),
        provider_effect_executed: false,
        raw_provider_material_retained: false,
    }
}

fn doctor_hint(status: &ProviderHealthStatus) -> String {
    match status {
        ProviderHealthStatus::Healthy => "provider runtime evidence is healthy".to_owned(),
        ProviderHealthStatus::Watch => "inspect provider backpressure summaries".to_owned(),
        ProviderHealthStatus::RepairRequired => {
            "inspect provider runtime repair records".to_owned()
        }
        ProviderHealthStatus::Blocked => "inspect provider retention policy blockers".to_owned(),
    }
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{provider_retention_policy, ProviderRetentionPolicyInput};

    #[test]
    fn provider_health_summary_is_reference_only_and_sanitized() {
        let retention = provider_retention_policy(ProviderRetentionPolicyInput {
            record_ref: "record:1".to_owned(),
            evidence_refs: vec!["evidence:retention:1".to_owned()],
            artifact_refs: Vec::new(),
            raw_payload_present: true,
            raw_stream_present: false,
            secret_material_present: false,
            credential_material_present: false,
            unbounded_local_path_present: false,
            artifact_policy_approved: true,
            diagnostics_requested: true,
        });

        let summary =
            provider_health_summary("codex:local-default".to_owned(), &[], &[], &[retention]);

        assert_eq!(summary.status, ProviderHealthStatus::Blocked);
        assert_eq!(
            summary.doctor_hint,
            "inspect provider retention policy blockers"
        );
        assert!(!summary.provider_effect_executed);
        assert!(!summary.raw_provider_material_retained);
    }
}
