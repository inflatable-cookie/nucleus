use crate::{
    codex_turn_start_diagnostics, CodexAppServerTurnStartOutcomeId,
    CodexAppServerTurnStartOutcomeRecord, CodexAppServerTurnStartOutcomeStatus,
};

#[test]
fn codex_turn_start_diagnostics_are_read_only_and_sanitized() {
    let diagnostics = codex_turn_start_diagnostics(&[
        CodexAppServerTurnStartOutcomeRecord {
            outcome_id: CodexAppServerTurnStartOutcomeId("outcome:accepted".to_owned()),
            request_id: "request:accepted".to_owned(),
            admission_id: Some("admission:accepted".to_owned()),
            envelope_id: Some("envelope:accepted".to_owned()),
            status: CodexAppServerTurnStartOutcomeStatus::Accepted,
            evidence_refs: vec!["evidence:accepted".to_owned()],
            raw_payload_retained: false,
            task_mutation_permitted: false,
            summary: "accepted turn start".to_owned(),
        },
        CodexAppServerTurnStartOutcomeRecord {
            outcome_id: CodexAppServerTurnStartOutcomeId("outcome:blocked".to_owned()),
            request_id: "request:blocked".to_owned(),
            admission_id: Some("admission:blocked".to_owned()),
            envelope_id: None,
            status: CodexAppServerTurnStartOutcomeStatus::Blocked("not ready".to_owned()),
            evidence_refs: vec!["evidence:blocked".to_owned()],
            raw_payload_retained: false,
            task_mutation_permitted: false,
            summary: "blocked turn start".to_owned(),
        },
    ]);
    let json = serde_json::to_string(&diagnostics).expect("serialize diagnostics");

    assert_eq!(diagnostics.source_status, "records");
    assert!(!diagnostics.client_can_start_turns);
    assert!(!diagnostics.client_can_answer_callbacks);
    assert!(!diagnostics.client_can_mutate_tasks);
    assert_eq!(
        diagnostics.outcomes[0].next_action,
        "wait_for_provider_observations"
    );
    assert_eq!(
        diagnostics.outcomes[1].next_action,
        "repair_admission_inputs"
    );
    assert!(!diagnostics.outcomes[0].raw_payload_retained);
    assert!(!diagnostics.outcomes[0].task_mutation_permitted);
    assert!(!json.contains("raw_prompt"));
    assert!(!json.contains("raw_provider_payload"));
    assert!(!json.contains("terminal_stream"));
}
