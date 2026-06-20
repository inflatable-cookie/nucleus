use super::*;

mod change_request;
mod dry_run;
mod workflow_review;

fn persist_scm_capture_dry_run_plan<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_capture_dry_run_plan(
        handler.state(),
        crate::ScmCaptureDryRunPersistenceInput {
            plan_item: crate::ScmCaptureDryRunPlanItem {
                dry_run_plan_item_id: "dry-run-plan:handler".to_owned(),
                dry_run_candidate_id: "dry-run-candidate:handler".to_owned(),
                persisted_preparation_id: "persisted-preparation:handler".to_owned(),
                plan_item_id: "plan:handler".to_owned(),
                admission_id: "admission:handler".to_owned(),
                readiness_id: "readiness:handler".to_owned(),
                capture_candidate_id: "candidate:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                evidence_refs: vec!["evidence:dry-run-handler".to_owned()],
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                status: crate::ScmCaptureDryRunPlanStatus::Ready,
                blockers: Vec::new(),
            },
            existing_dry_run_plan_ids: Vec::new(),
            raw_material_present: false,
            scm_dry_run_requested: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm capture dry-run plan");
}

fn persist_scm_capture_dry_run_execution_receipt<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_capture_dry_run_execution_receipt(
        handler.state(),
        crate::ScmCaptureDryRunExecutionPersistenceInput {
            receipt: crate::ScmCaptureDryRunReceiptRecord {
                receipt_id: "receipt:handler".to_owned(),
                capability_item_id: "capability:handler".to_owned(),
                admission_id: "admission:handler".to_owned(),
                persisted_dry_run_plan_id: "persisted-dry-run:handler".to_owned(),
                dry_run_plan_item_id: "dry-run-plan:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                operator_ref: "operator:tom".to_owned(),
                adapter_label: "adapter:handler".to_owned(),
                workflow_label: "workflow:handler".to_owned(),
                outcome: crate::ScmCaptureDryRunReceiptStatus::Completed,
                blockers: Vec::new(),
                evidence_refs: vec!["evidence:dry-run-execution-handler".to_owned()],
                changed_path_count: 2,
                summary_line_count: 4,
                scm_dry_run_executed: true,
                scm_capture_executed: false,
                scm_publish_executed: false,
                forge_change_request_created: false,
                forge_merge_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_material_exposed: false,
            },
            existing_execution_receipt_ids: Vec::new(),
            raw_output_present: false,
            scm_capture_requested: false,
            scm_publish_requested: false,
            forge_change_request_requested: false,
            forge_merge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm capture dry-run execution receipt");
}

fn persist_git_dry_run_execution<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_git_dry_run_execution(
        handler.state(),
        crate::GitDryRunExecutionPersistenceInput {
            capture: crate::GitDryRunEvidenceCaptureRecord {
                capture_id: "capture:handler".to_owned(),
                handoff_id: "handoff:handler".to_owned(),
                request_id: "request:handler".to_owned(),
                descriptor_id: "git-dry-run-diff-stat".to_owned(),
                repo_id: "repo:handler".to_owned(),
                status: crate::GitDryRunEvidenceCaptureStatus::Completed,
                blockers: Vec::new(),
                exit_code: Some(0),
                changed_path_count: 3,
                staged_path_count: 1,
                unstaged_path_count: 1,
                untracked_path_count: 1,
                insertion_count: 12,
                deletion_count: 4,
                evidence_refs: vec!["evidence:git-dry-run-handler".to_owned()],
                git_dry_run_executed: true,
                git_mutation_executed: false,
                forge_effect_executed: false,
                provider_write_executed: false,
                callback_response_executed: false,
                interruption_executed: false,
                recovery_executed: false,
                raw_output_retained: false,
            },
            existing_execution_ids: Vec::new(),
            raw_stdout_present: false,
            raw_stderr_present: false,
            raw_diff_present: false,
            checkout_requested: false,
            branch_mutation_requested: false,
            commit_requested: false,
            push_requested: false,
            forge_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist git dry-run execution");
}

fn persist_scm_capture_review_decision<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_capture_review_decision(
        handler.state(),
        crate::ScmCaptureReviewDecisionPersistenceInput {
            readiness: crate::ScmCaptureReviewReadinessRecord {
                readiness_id: "readiness:handler".to_owned(),
                workflow_id: "workflow:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                repo_id: "repo:handler".to_owned(),
                operator_ref: "operator:handler".to_owned(),
                status: crate::ScmCaptureReviewReadinessStatus::Ready,
                blockers: Vec::new(),
                evidence_refs: vec!["evidence:handler".to_owned()],
                review_ready: true,
                change_request_authority_granted: false,
                scm_mutation_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                callback_authority_granted: false,
                interruption_authority_granted: false,
                recovery_authority_granted: false,
                raw_output_retained: false,
            },
            decision: crate::ScmCaptureReviewDecision::Accept,
            existing_decision_ids: Vec::new(),
            raw_output_present: false,
            change_request_requested: false,
            scm_mutation_requested: false,
            forge_effect_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm capture review decision");
}

fn persist_scm_change_request_prep<B>(handler: &LocalControlRequestHandler<B>)
where
    B: nucleus_local_store::LocalStoreBackend + Clone,
{
    crate::persist_scm_change_request_prep(
        handler.state(),
        crate::ScmChangeRequestPrepPersistenceInput {
            admission: crate::ScmChangeRequestPrepAdmissionRecord {
                admission_id: "admission:handler".to_owned(),
                decision_id: "decision:handler".to_owned(),
                readiness_id: "readiness:handler".to_owned(),
                workflow_id: "workflow:handler".to_owned(),
                task_id: "task:handler".to_owned(),
                work_item_id: Some("work:handler".to_owned()),
                completion_id: Some("completion:handler".to_owned()),
                repo_id: "repo:handler".to_owned(),
                operator_ref: "operator:handler".to_owned(),
                adapter_label: "adapter:scm".to_owned(),
                workflow_label: "change-request".to_owned(),
                evidence_refs: vec!["evidence:handler".to_owned()],
                status: crate::ScmChangeRequestPrepAdmissionStatus::Admitted,
                blockers: Vec::new(),
                preparation_admitted: true,
                branch_or_snapshot_authority_granted: false,
                commit_or_publish_authority_granted: false,
                push_or_remote_publish_authority_granted: false,
                forge_authority_granted: false,
                provider_authority_granted: false,
                callback_authority_granted: false,
                interruption_authority_granted: false,
                recovery_authority_granted: false,
                raw_output_retained: false,
            },
            existing_preparation_ids: Vec::new(),
            raw_output_present: false,
            branch_or_snapshot_requested: false,
            commit_or_publish_requested: false,
            push_or_remote_publish_requested: false,
            forge_effect_requested: false,
            provider_write_requested: false,
            callback_response_requested: false,
            interruption_requested: false,
            recovery_requested: false,
        },
    )
    .expect("persist scm change request prep");
}
