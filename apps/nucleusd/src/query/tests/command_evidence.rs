use nucleus_local_store::SqliteBackend;
use nucleus_server::{ControlCommandEvidenceRecordDto, LocalControlRequestHandler};

use super::*;

#[test]
fn command_evidence_query_decodes_sanitized_records() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let state_path = temp_dir.path().join("nucleus.sqlite");
    crate::run(vec![
        "--state".to_owned(),
        state_path.display().to_string(),
        "command-runner".to_owned(),
        "smoke".to_owned(),
    ])
    .expect("run command-runner smoke");

    let backend = SqliteBackend::new(state_path);
    let mut handler = LocalControlRequestHandler::new(backend, None);

    print_query(&mut handler, QueryDomain::CommandEvidence).expect("print evidence query");
}

#[test]
fn command_evidence_response_lines_do_not_include_raw_output() {
    let lines = typed_response::command_evidence_response_lines(
        "command-evidence",
        vec![ControlCommandEvidenceRecordDto {
            evidence_id: "command:evidence:test".to_owned(),
            command_request_id: "command:request:test".to_owned(),
            status: "succeeded".to_owned(),
            exit_status: Some(0),
            retention: "summary_only".to_owned(),
            summary: Some("sanitized summary".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        }],
    );
    let rendered = lines.join("\n");

    assert!(rendered.contains("raw_output=not_retained"));
    assert!(rendered.contains("sanitized summary"));
    assert!(!rendered.contains("raw_stdout"));
    assert!(!rendered.contains("raw_stderr"));
    assert!(!rendered.contains("recognizable-raw-output"));
}
