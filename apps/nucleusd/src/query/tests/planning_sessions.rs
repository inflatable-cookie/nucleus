use nucleus_server::{
    ControlPlanningSessionOutputRefsDto, ControlPlanningSessionSourceCountsDto,
    ControlPlanningSessionSummaryDto,
};

use super::*;

#[test]
fn planning_sessions_response_lines_are_read_only_and_sanitized() {
    let lines = typed_response::planning_sessions_response_lines(
        "planning-sessions",
        "project:nucleus-local".to_owned(),
        vec![ControlPlanningSessionSummaryDto {
            session_id: "planning-session:nucleus-local:bootstrap".to_owned(),
            kind: "project_intake".to_owned(),
            status: "active".to_owned(),
            prompt_or_template_refs: vec!["template:intake".to_owned()],
            participant_count: 1,
            source_ref_count: 1,
            source_kind_counts: Vec::new(),
            output_refs: ControlPlanningSessionOutputRefsDto {
                artifact_refs: Vec::new(),
                task_seed_refs: vec!["seed:nucleus-local:planning-bootstrap".to_owned()],
                memory_proposal_refs: Vec::new(),
                research_run_brief_refs: Vec::new(),
            },
        }],
        Vec::new(),
        ControlPlanningSessionSourceCountsDto {
            planning_session_records: 1,
            exploration_session_records: 0,
            prompt_or_template_refs: 1,
            participant_refs: 1,
            source_refs: 1,
            output_refs: 1,
        },
        false,
        false,
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("domain=planning-sessions"));
    assert!(rendered.contains("project_id=project:nucleus-local"));
    assert!(rendered.contains("sessions=1"));
    assert!(rendered.contains("client_can_mutate=false"));
    assert!(rendered.contains("provider_execution_available=false"));
    assert!(rendered.contains("task_seed_refs=1"));
    assert!(!rendered.contains("raw_transcript"));
    assert!(!rendered.contains("provider_payload"));
    assert!(!rendered.contains("private_memory"));
}
