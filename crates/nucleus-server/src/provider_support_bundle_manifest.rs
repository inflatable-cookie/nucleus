//! Provider support bundle manifests.
//!
//! Manifests enumerate sanitized evidence refs for operator support. They do
//! not collect payloads or include raw provider material.

use serde::{Deserialize, Serialize};

use crate::{ProviderRuntimeRepairRecord, ProviderTraceSpanRecord};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderSupportBundleManifestInput {
    pub bundle_id: String,
    pub provider_instance_id: String,
    pub session_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub outcome_refs: Vec<String>,
    pub trace_spans: Vec<ProviderTraceSpanRecord>,
    pub repair_records: Vec<ProviderRuntimeRepairRecord>,
    pub artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub retention_policy_ref: String,
    pub redaction_policy_ref: String,
    pub raw_material_requested: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderSupportBundleManifestRecord {
    pub bundle_id: String,
    pub provider_instance_id: String,
    pub session_refs: Vec<String>,
    pub receipt_refs: Vec<String>,
    pub outcome_refs: Vec<String>,
    pub trace_span_refs: Vec<String>,
    pub repair_refs: Vec<String>,
    pub missing_evidence_refs: Vec<String>,
    pub artifact_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
    pub retention_policy_ref: String,
    pub redaction_policy_ref: String,
    pub payload_collection_in_scope: bool,
    pub raw_provider_material_included: bool,
    pub client_safe: bool,
}

pub fn provider_support_bundle_manifest(
    input: ProviderSupportBundleManifestInput,
) -> ProviderSupportBundleManifestRecord {
    assert_manifest_input(&input);
    let trace_span_refs = input
        .trace_spans
        .iter()
        .map(|span| span.span_id.clone())
        .collect::<Vec<_>>();
    let repair_refs = input
        .repair_records
        .iter()
        .map(|repair| repair.repair_id.clone())
        .collect::<Vec<_>>();
    let missing_evidence_refs = required_ref_gaps(&input);

    ProviderSupportBundleManifestRecord {
        bundle_id: input.bundle_id,
        provider_instance_id: input.provider_instance_id,
        session_refs: unique_sorted(input.session_refs),
        receipt_refs: unique_sorted(input.receipt_refs),
        outcome_refs: unique_sorted(input.outcome_refs),
        trace_span_refs: unique_sorted(trace_span_refs),
        repair_refs: unique_sorted(repair_refs),
        missing_evidence_refs,
        artifact_refs: unique_sorted(input.artifact_refs),
        evidence_refs: unique_sorted(input.evidence_refs),
        retention_policy_ref: input.retention_policy_ref,
        redaction_policy_ref: input.redaction_policy_ref,
        payload_collection_in_scope: false,
        raw_provider_material_included: false,
        client_safe: true,
    }
}

fn assert_manifest_input(input: &ProviderSupportBundleManifestInput) {
    assert!(!input.bundle_id.trim().is_empty(), "bundle id is required");
    assert!(
        !input.provider_instance_id.trim().is_empty(),
        "provider instance id is required"
    );
    assert!(
        !input.retention_policy_ref.trim().is_empty()
            && !input.redaction_policy_ref.trim().is_empty(),
        "retention and redaction policy refs are required"
    );
    assert!(
        !input.raw_material_requested,
        "support bundles cannot request raw provider material"
    );
}

fn required_ref_gaps(input: &ProviderSupportBundleManifestInput) -> Vec<String> {
    let mut gaps = Vec::new();
    if input.session_refs.is_empty() {
        gaps.push("missing_session_ref".to_owned());
    }
    if input.evidence_refs.is_empty() {
        gaps.push("missing_evidence_ref".to_owned());
    }
    gaps
}

fn unique_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        provider_trace_span_record, ProviderTraceComponent, ProviderTraceSpanInput,
        ProviderTraceStatus,
    };

    #[test]
    fn provider_support_bundle_manifest_lists_evidence_refs_without_payloads() {
        let manifest = provider_support_bundle_manifest(input());

        assert!(manifest
            .evidence_refs
            .contains(&"evidence:bundle:1".to_owned()));
        assert_eq!(manifest.trace_span_refs, vec!["span:1"]);
        assert!(!manifest.payload_collection_in_scope);
        assert!(!manifest.raw_provider_material_included);
        assert!(manifest.client_safe);
    }

    #[test]
    fn provider_support_bundle_manifest_represents_missing_evidence_as_repair_need() {
        let mut input = input();
        input.session_refs.clear();
        input.evidence_refs.clear();

        let manifest = provider_support_bundle_manifest(input);

        assert!(manifest
            .missing_evidence_refs
            .contains(&"missing_session_ref".to_owned()));
        assert!(manifest
            .missing_evidence_refs
            .contains(&"missing_evidence_ref".to_owned()));
    }

    fn input() -> ProviderSupportBundleManifestInput {
        ProviderSupportBundleManifestInput {
            bundle_id: "support-bundle:1".to_owned(),
            provider_instance_id: "codex:local-default".to_owned(),
            session_refs: vec!["runtime-session:1".to_owned()],
            receipt_refs: vec!["receipt:1".to_owned()],
            outcome_refs: vec!["outcome:1".to_owned()],
            trace_spans: vec![provider_trace_span_record(ProviderTraceSpanInput {
                span_id: "span:1".to_owned(),
                parent_span_id: None,
                provider_instance_id: "codex:local-default".to_owned(),
                component: ProviderTraceComponent::TransportWrite,
                status: ProviderTraceStatus::Completed,
                duration_millis: 10,
                command_id: Some("command:1".to_owned()),
                dispatch_attempt_id: Some("dispatch:1".to_owned()),
                runtime_session_ref: Some("runtime-session:1".to_owned()),
                receipt_id: Some("receipt:1".to_owned()),
                outcome_id: Some("outcome:1".to_owned()),
                evidence_refs: vec!["evidence:span:1".to_owned()],
                summary: "completed".to_owned(),
                raw_provider_material_requested: false,
                raw_stream_requested: false,
                client_authority_requested: false,
            })],
            repair_records: Vec::new(),
            artifact_refs: vec!["artifact:summary:1".to_owned()],
            evidence_refs: vec!["evidence:bundle:1".to_owned()],
            retention_policy_ref: "retention:reference-only".to_owned(),
            redaction_policy_ref: "redaction:default".to_owned(),
            raw_material_requested: false,
        }
    }
}
