use nucleus_core::RevisionId;
use nucleus_engine::{
    EngineTaskAgentWorkUnitReviewStatus, EngineTaskAgentWorkUnitRuntimeStatus,
    EngineTaskWorkItemRefs,
};
use nucleus_local_store::{LocalStoreError, RevisionExpectation};

use crate::task_agent_work_unit_state::{
    read_task_agent_work_unit_source_records, write_task_agent_work_unit_source_record,
};

use super::fixtures::{source_record, state, transitioned_source_record};

#[test]
fn task_agent_source_records_accept_allowed_runtime_transitions() {
    let (_temp_dir, service) = state();
    let scheduled = source_record("source:task-agent:1", "0001");
    write_task_agent_work_unit_source_record(
        &service,
        scheduled.clone(),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");

    let running = transitioned_source_record(
        &scheduled,
        "source:task-agent:2",
        "0002",
        EngineTaskAgentWorkUnitRuntimeStatus::Running,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    write_task_agent_work_unit_source_record(
        &service,
        running,
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running source");

    let records = read_task_agent_work_unit_source_records(&service).expect("read records");
    assert_eq!(records.len(), 2);
    assert_eq!(
        records[1].runtime,
        EngineTaskAgentWorkUnitRuntimeStatus::Running
    );
}

#[test]
fn task_agent_source_records_reject_runtime_jumps() {
    let (_temp_dir, service) = state();
    let scheduled = source_record("source:task-agent:1", "0001");
    write_task_agent_work_unit_source_record(
        &service,
        scheduled.clone(),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");

    let completed = transitioned_source_record(
        &scheduled,
        "source:task-agent:2",
        "0002",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    let error = write_task_agent_work_unit_source_record(
        &service,
        completed,
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect_err("reject scheduled to completed jump");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
}

#[test]
fn task_agent_source_records_require_review_evidence_before_awaiting_review() {
    let (_temp_dir, service) = state();
    let scheduled = source_record("source:task-agent:1", "0001");
    write_task_agent_work_unit_source_record(
        &service,
        scheduled.clone(),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");
    let running = transitioned_source_record(
        &scheduled,
        "source:task-agent:2",
        "0002",
        EngineTaskAgentWorkUnitRuntimeStatus::Running,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    write_task_agent_work_unit_source_record(
        &service,
        running.clone(),
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running source");

    let mut completed_without_evidence = transitioned_source_record(
        &running,
        "source:task-agent:3",
        "0003",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
    );
    completed_without_evidence.refs = EngineTaskWorkItemRefs::default();

    let error = write_task_agent_work_unit_source_record(
        &service,
        completed_without_evidence,
        RevisionId("rev:3".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect_err("reject awaiting review without evidence");

    assert!(matches!(error, LocalStoreError::InvalidRecord { .. }));
}

#[test]
fn task_agent_source_records_accept_review_decision_after_awaiting_review() {
    let (_temp_dir, service) = state();
    let scheduled = source_record("source:task-agent:1", "0001");
    write_task_agent_work_unit_source_record(
        &service,
        scheduled.clone(),
        RevisionId("rev:1".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write scheduled source");
    let running = transitioned_source_record(
        &scheduled,
        "source:task-agent:2",
        "0002",
        EngineTaskAgentWorkUnitRuntimeStatus::Running,
        EngineTaskAgentWorkUnitReviewStatus::NotReady,
    );
    write_task_agent_work_unit_source_record(
        &service,
        running.clone(),
        RevisionId("rev:2".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write running source");
    let awaiting = transitioned_source_record(
        &running,
        "source:task-agent:3",
        "0003",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        EngineTaskAgentWorkUnitReviewStatus::AwaitingReview,
    );
    write_task_agent_work_unit_source_record(
        &service,
        awaiting.clone(),
        RevisionId("rev:3".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write awaiting review source");

    let accepted = transitioned_source_record(
        &awaiting,
        "source:task-agent:4",
        "0004",
        EngineTaskAgentWorkUnitRuntimeStatus::Completed,
        EngineTaskAgentWorkUnitReviewStatus::Accepted,
    );
    write_task_agent_work_unit_source_record(
        &service,
        accepted,
        RevisionId("rev:4".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write accepted review source");
}
