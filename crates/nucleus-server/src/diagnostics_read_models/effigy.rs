use serde::{Deserialize, Serialize};

use nucleus_native_harness::{
    NativeEffigyHealthSummary, NativeEffigyIntegrationStatus, NativeEffigyProjectIntegration,
    NativeEffigyValidationPlanSummary,
};

use super::helpers::source_summary;

/// Effigy diagnostics read model.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct EffigyDiagnosticsDto {
    pub integration_status: String,
    pub selector_refs: Vec<String>,
    pub health_status: Option<String>,
    pub validation_status: Option<String>,
    pub evidence_refs: Vec<String>,
    pub client_can_run_effigy: bool,
    pub source_status: String,
    pub source_summary: Option<String>,
}

pub fn effigy_diagnostics(
    integration: &NativeEffigyProjectIntegration,
    health: Option<&NativeEffigyHealthSummary>,
    validation: Option<&NativeEffigyValidationPlanSummary>,
) -> EffigyDiagnosticsDto {
    let record_count = integration.selectors.len()
        + integration.evidence_refs.len()
        + usize::from(health.is_some())
        + usize::from(validation.is_some());
    EffigyDiagnosticsDto {
        integration_status: format!("{:?}", integration.status),
        selector_refs: integration
            .selectors
            .iter()
            .map(|selector| selector.selector_ref.0.clone())
            .collect(),
        health_status: health.map(|summary| format!("{:?}", summary.status)),
        validation_status: validation.map(|summary| format!("{:?}", summary.status)),
        evidence_refs: integration
            .evidence_refs
            .iter()
            .map(|evidence| evidence.0.clone())
            .collect(),
        client_can_run_effigy: false,
        source_status: effigy_source_status(integration, record_count),
        source_summary: integration.summary.clone().or_else(|| {
            Some(source_summary(
                record_count,
                "effigy source records are not persisted yet",
                "effigy diagnostics loaded from source records",
            ))
        }),
    }
}

fn effigy_source_status(
    integration: &NativeEffigyProjectIntegration,
    record_count: usize,
) -> String {
    if integration.status == NativeEffigyIntegrationStatus::Disabled {
        "disabled".to_owned()
    } else if record_count == 0 {
        "empty".to_owned()
    } else {
        "records".to_owned()
    }
}
