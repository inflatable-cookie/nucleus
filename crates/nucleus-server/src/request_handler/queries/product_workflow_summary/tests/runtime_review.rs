use nucleus_projects::ProjectId;

use super::super::*;
use super::support::handler_with_project_task;
use crate::ProductWorkflowGapArea;

#[test]
fn product_workflow_summary_query_composes_runtime_and_review_refs() {
    let (_temp_dir, handler) = handler_with_project_task();
    seed_command_evidence(&handler);
    seed_runtime_receipt(&handler);
    seed_review_decision(&handler);
    seed_task_completion(&handler);

    let result = product_workflow_summary_query(
        &handler,
        ProductWorkflowSummaryQuery {
            project_id: ProjectId("project:nucleus-local".to_owned()),
        },
    )
    .expect("product workflow summary");

    let ServerQueryResult::ProductWorkflowSummary(summary) = result else {
        panic!("expected product workflow summary result");
    };

    assert_eq!(summary.source_counts.command_evidence_refs, 1);
    assert_eq!(summary.source_counts.runtime_evidence_refs, 2);
    assert_eq!(summary.source_counts.review_refs, 1);
    assert_eq!(
        summary.runtime.command_evidence_refs,
        vec!["command:evidence:product-workflow".to_owned()]
    );
    assert_eq!(
        summary.runtime.runtime_evidence_refs,
        vec![
            "live-evidence-task-completion:task:nucleus-local:bootstrap:work:nucleus-local"
                .to_owned(),
            "receipt:product-workflow:read-only-command".to_owned(),
        ]
    );
    assert_eq!(
        summary.review.review_refs,
        vec!["live-evidence-review-decision:work:nucleus-local:readiness:nucleus-local".to_owned()]
    );
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Runtime));
    assert!(summary
        .gaps
        .iter()
        .all(|gap| gap.area != ProductWorkflowGapArea::Review));
    assert!(!summary.no_effects.provider_execution_performed);
    assert!(!summary.no_effects.task_mutation_performed);
    assert!(!summary.no_effects.agent_scheduling_performed);
}

fn seed_command_evidence(
    handler: &crate::request_handler::LocalControlRequestHandler<
        nucleus_local_store::SqliteBackend,
    >,
) {
    use nucleus_command_policy::{
        CommandEvidence, CommandEvidenceId, CommandExecutionStatus, CommandOutputRetention,
        CommandRequestId,
    };
    use nucleus_core::RevisionId;
    use nucleus_local_store::RevisionExpectation;

    crate::write_command_evidence(
        handler.state(),
        &CommandEvidence {
            id: CommandEvidenceId("command:evidence:product-workflow".to_owned()),
            request_id: CommandRequestId("command:request:product-workflow".to_owned()),
            status: CommandExecutionStatus::Succeeded,
            exit_status: Some(0),
            retention: CommandOutputRetention::SummaryOnly,
            summary: Some("product workflow evidence".to_owned()),
            stdout_artifact_ref: None,
            stderr_artifact_ref: None,
        },
        RevisionId("rev:command-evidence:product-workflow".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write command evidence");
}

fn seed_runtime_receipt(
    handler: &crate::request_handler::LocalControlRequestHandler<
        nucleus_local_store::SqliteBackend,
    >,
) {
    use nucleus_core::RevisionId;
    use nucleus_engine::{
        EngineRuntimeReceiptEffectFamily, EngineRuntimeReceiptRecord, EngineRuntimeReceiptRecordId,
        EngineRuntimeReceiptRef, EngineRuntimeReceiptStatus,
    };
    use nucleus_local_store::RevisionExpectation;

    crate::write_runtime_receipt(
        handler.state(),
        &EngineRuntimeReceiptRecord {
            receipt_id: EngineRuntimeReceiptRecordId(
                "receipt:product-workflow:read-only-command".to_owned(),
            ),
            family: EngineRuntimeReceiptEffectFamily::CommandExecution,
            status: EngineRuntimeReceiptStatus::Completed,
            command_ref: Some(EngineRuntimeReceiptRef::CommandId(
                "command:product-workflow".to_owned(),
            )),
            effect_ref: Some(EngineRuntimeReceiptRef::CommandRequestId(
                "command:request:product-workflow".to_owned(),
            )),
            evidence_refs: vec![EngineRuntimeReceiptRef::CommandEvidenceId(
                "command:evidence:product-workflow".to_owned(),
            )],
            artifact_refs: Vec::new(),
            summary: Some("product workflow receipt".to_owned()),
        },
        RevisionId("rev:receipt:product-workflow".to_owned()),
        RevisionExpectation::MustNotExist,
    )
    .expect("write runtime receipt");
}

fn seed_review_decision(
    handler: &crate::request_handler::LocalControlRequestHandler<
        nucleus_local_store::SqliteBackend,
    >,
) {
    crate::persist_live_evidence_review_decision(
        handler.state(),
        crate::LiveEvidenceReviewDecisionPersistenceInput {
            admission: crate::LiveEvidenceReviewAcceptanceAdmissionRecord {
                admission_id: "admission:nucleus-local".to_owned(),
                readiness_id: "readiness:nucleus-local".to_owned(),
                observation_id: "observation:nucleus-local".to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                work_item_id: "work:nucleus-local".to_owned(),
                status: crate::LiveEvidenceReviewAcceptanceAdmissionStatus::Admitted,
                blockers: Vec::new(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:review:nucleus-local".to_owned()],
                decision: crate::LiveEvidenceReviewDecision::Accept,
                task_completion_permitted: false,
                provider_write_permitted: false,
                callback_response_permitted: false,
                cancellation_permitted: false,
                resume_permitted: false,
                scm_mutation_permitted: false,
            },
            existing_decision_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            task_completion_requested: false,
        },
    )
    .expect("persist review decision");
}

fn seed_task_completion(
    handler: &crate::request_handler::LocalControlRequestHandler<
        nucleus_local_store::SqliteBackend,
    >,
) {
    crate::persist_live_evidence_task_completion(
        handler.state(),
        crate::LiveEvidenceTaskCompletionPersistenceInput {
            admission: crate::LiveEvidenceTaskCompletionAdmissionRecord {
                admission_id: "completion-admission:nucleus-local".to_owned(),
                review_decision_id:
                    "live-evidence-review-decision:work:nucleus-local:readiness:nucleus-local"
                        .to_owned(),
                task_id: "task:nucleus-local:bootstrap".to_owned(),
                work_item_id: "work:nucleus-local".to_owned(),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:completion:nucleus-local".to_owned()],
                status: crate::LiveEvidenceTaskCompletionAdmissionStatus::Admitted,
                blockers: Vec::new(),
                task_completion_admitted: true,
                provider_write_permitted: false,
                callback_response_permitted: false,
                cancellation_permitted: false,
                resume_permitted: false,
                scm_mutation_permitted: false,
                raw_provider_material_retained: false,
                raw_stream_retained: false,
            },
            existing_completion_ids: Vec::new(),
            raw_provider_material_present: false,
            raw_stream_present: false,
            provider_write_requested: false,
            callback_response_requested: false,
            cancellation_requested: false,
            resume_requested: false,
            scm_mutation_requested: false,
        },
    )
    .expect("persist task completion");
}
