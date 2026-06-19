use super::*;

#[test]
fn effigy_diagnostics_expose_health_and_validation_without_raw_output() {
    let integration = NativeEffigyProjectIntegration {
        status: NativeEffigyIntegrationStatus::Enabled,
        scope: NativeEffigyScope::ProjectRoot,
        manifest_ref: None,
        selectors: vec![NativeEffigySelectorRecord {
            selector_ref: NativeEffigySelectorRef("qa:northstar".to_owned()),
            kind: NativeEffigySelectorKind::Validation,
            scope: NativeEffigyScope::ProjectRoot,
            command_scope_hint: nucleus_native_harness::NativeEffigyCommandScopeHint::ReadOnly,
            purpose: Some("docs validation".to_owned()),
            evidence_refs: Vec::new(),
        }],
        evidence_refs: Vec::new(),
        summary: None,
    };
    let health = NativeEffigyHealthSummary {
        status: NativeEffigyHealthStatus::Ok,
        scope: NativeEffigyScope::ProjectRoot,
        tool_action_id: None,
        receipt_refs: Vec::new(),
        evidence_refs: Vec::new(),
        repair_hints: Vec::new(),
        summary: Some("effigy ready".to_owned()),
    };
    let mut validation =
        NativeEffigyValidationPlanSummary::planned_only(NativeEffigyScope::ProjectRoot, vec![]);
    validation.summary = Some("planned only".to_owned());

    let diagnostics = effigy_diagnostics(&integration, Some(&health), Some(&validation));
    let json = serde_json::to_string(&diagnostics).expect("serialize effigy diagnostics");

    assert_eq!(diagnostics.integration_status, "Enabled");
    assert_eq!(diagnostics.selector_refs, vec!["qa:northstar".to_owned()]);
    assert!(!diagnostics.client_can_run_effigy);
    assert_eq!(diagnostics.source_status, "records");
    assert!(!json.contains("raw_stdout"));
}
