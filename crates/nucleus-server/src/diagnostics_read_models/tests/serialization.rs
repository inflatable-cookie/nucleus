use super::*;

#[test]
fn diagnostics_dtos_serialize_without_authority_drift() {
    let diagnostics = ScmSessionDiagnosticsDto {
        sessions: Vec::new(),
        admissions: Vec::new(),
        work_item_links: Vec::new(),
        client_can_mutate_working_copy: false,
        source_status: "empty".to_owned(),
        source_summary: Some("scm session source records are not persisted yet".to_owned()),
    };
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert!(json.contains("client_can_mutate_working_copy"));
    assert!(json.contains("source_status"));
    assert!(!json.contains("raw_stdout"));
    assert!(!json.contains("provider payload"));
}
