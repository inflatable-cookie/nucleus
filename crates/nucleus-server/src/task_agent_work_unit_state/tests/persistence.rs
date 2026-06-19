use nucleus_core::RevisionId;
use nucleus_local_store::{LocalStoreError, RevisionExpectation, SqliteBackend};

use crate::state::ServerStateService;
use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};

use super::fixtures::{source_record, state};

#[test]
fn task_agent_source_records_survive_reopen() {
    let temp_dir = tempfile::tempdir().expect("temp dir");
    let database_path = temp_dir.path().join("nucleus.sqlite");

    {
        let service = ServerStateService::new(SqliteBackend::new(database_path.clone()));
        write_task_agent_work_unit_source_record(
            &service,
            source_record("source:task-agent:1", "0001"),
            RevisionId("rev:1".to_owned()),
            RevisionExpectation::MustNotExist,
        )
        .expect("write source record");
    }

    let service = ServerStateService::new(SqliteBackend::new(database_path));
    let records = read_task_agent_work_unit_source_records(&service).expect("read records");
    assert_eq!(records, vec![source_record("source:task-agent:1", "0001")]);
}

#[test]
fn task_agent_source_records_sort_by_source_cursor() {
    let (_temp_dir, service) = state();
    write_task_agent_work_unit_source_record(
        &service,
        source_record("source:task-agent:2", "0002"),
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write second");
    write_task_agent_work_unit_source_record(
        &service,
        source_record("source:task-agent:1", "0001"),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write first");

    let records = read_task_agent_work_unit_source_records(&service).expect("read records");

    assert_eq!(
        records
            .iter()
            .map(|record| record.source_id.0.as_str())
            .collect::<Vec<_>>(),
        vec!["source:task-agent:1", "source:task-agent:2"]
    );
}

#[test]
fn task_agent_source_records_reject_raw_provider_material() {
    let (_temp_dir, service) = state();
    let mut record = source_record("source:task-agent:1", "0001");
    record.summary = "contains raw stdout from provider".to_owned();

    let error = write_task_agent_work_unit_source_record(
        &service,
        record,
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect_err("reject raw material");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
    assert_eq!(
        read_task_agent_work_unit_source_records(&service).expect("read records"),
        Vec::new()
    );
}

#[test]
fn task_agent_source_records_honor_revision_expectations() {
    let (_temp_dir, service) = state();
    write_task_agent_work_unit_source_record(
        &service,
        source_record("source:task-agent:1", "0001"),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write source record");

    let error = write_task_agent_work_unit_source_record(
        &service,
        source_record("source:task-agent:1", "0002"),
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect_err("reject duplicate without expected revision");

    assert!(matches!(error, LocalStoreError::RevisionConflict(_)));
}
