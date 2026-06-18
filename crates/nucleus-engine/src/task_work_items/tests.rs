    use super::*;
    use crate::{
        EngineCheckpointRecordId, EngineDiffSummaryRecordId, EngineRuntimeReceiptRecordId,
        EngineTaskTimelineEntryId,
    };
    use nucleus_agent_protocol::{AgentSessionId, AgentTurnId};
    use nucleus_projects::ProjectId;
    use nucleus_tasks::{TaskActionType, TaskId};

    fn work_item(id: &str, task_id: &str) -> EngineTaskWorkItemRecord {
        EngineTaskWorkItemRecord {
            work_item_id: EngineTaskWorkItemId(id.to_owned()),
            task_id: TaskId(task_id.to_owned()),
            project_id: ProjectId("project:nucleus".to_owned()),
            title: "Implement task-backed work item".to_owned(),
            intent: TaskActionType::Execute,
            assignment: EngineTaskWorkItemAssignment::AdapterInstance {
                adapter_id: "adapter:codex-app-server".to_owned(),
                provider_instance_id: "codex:local-default".to_owned(),
            },
            runtime: EngineTaskWorkItemRuntimeState::Completed,
            review: EngineTaskWorkItemReviewState::AwaitingReview,
            refs: EngineTaskWorkItemRefs {
                session_id: Some(AgentSessionId("session:nucleus".to_owned())),
                turn_ids: vec![AgentTurnId("turn:nucleus".to_owned())],
                receipt_ids: vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:1".to_owned())],
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:1".to_owned())],
                timeline_entry_ids: vec![EngineTaskTimelineEntryId("timeline:1".to_owned())],
                validation_refs: vec!["validation:effigy:qa".to_owned()],
                artifact_refs: vec!["artifact:diff-summary".to_owned()],
            },
            summary: Some("provider completed; awaiting operator review".to_owned()),
        }
    }

    #[test]
    fn task_can_own_multiple_work_items() {
        let set = EngineTaskWorkItemSet {
            task_id: TaskId("task:1".to_owned()),
            work_items: vec![work_item("work:1", "task:1"), work_item("work:2", "task:1")],
        };

        assert_eq!(set.records_for_task().len(), 2);
        assert!(set
            .records_for_task()
            .iter()
            .all(|work_item| work_item.task_id == TaskId("task:1".to_owned())));
    }

    #[test]
    fn work_item_links_runtime_evidence_by_reference() {
        let item = work_item("work:1", "task:1");

        assert_eq!(
            item.refs.session_id,
            Some(AgentSessionId("session:nucleus".to_owned()))
        );
        assert_eq!(
            item.refs.receipt_ids,
            vec![EngineRuntimeReceiptRecordId("receipt:1".to_owned())]
        );
        assert_eq!(
            item.refs.checkpoint_ids,
            vec![EngineCheckpointRecordId("checkpoint:1".to_owned())]
        );
        assert_eq!(
            item.refs.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:1".to_owned())]
        );
        assert!(item.uses_reference_only_runtime_links());
    }

    #[test]
    fn provider_completion_does_not_imply_operator_acceptance() {
        let item = work_item("work:1", "task:1");

        assert_eq!(item.runtime, EngineTaskWorkItemRuntimeState::Completed);
        assert_eq!(item.review, EngineTaskWorkItemReviewState::AwaitingReview);
        assert!(item.awaits_operator_acceptance());
    }

    #[test]
    fn work_item_shape_is_adapter_portable() {
        let mut item = work_item("work:1", "task:1");
        item.assignment = EngineTaskWorkItemAssignment::AdapterInstance {
            adapter_id: "adapter:cursor-acp".to_owned(),
            provider_instance_id: "cursor:local-default".to_owned(),
        };

        assert!(matches!(
            item.assignment,
            EngineTaskWorkItemAssignment::AdapterInstance { .. }
        ));
        assert_eq!(item.refs.turn_ids.len(), 1);
    }

    #[test]
    fn work_item_runtime_projection_is_deterministic_and_sanitized() {
        let item = work_item("work:1", "task:1");
        let first = item.runtime_projection();
        let second = item.runtime_projection();

        assert_eq!(first, second);
        assert_eq!(first.state, EngineTaskWorkItemRuntimeLinkState::Linked);
        assert_eq!(first.entries.len(), 8);
        assert!(first.entries.iter().any(|entry| entry.kind
            == EngineTaskWorkItemRuntimeProjectionEntryKind::Receipt
            && entry.source_ref == "receipt:1"));
        assert!(first
            .entries
            .iter()
            .all(|entry| !entry.summary.contains("raw provider payload")));
    }

    #[test]
    fn work_item_runtime_projection_surfaces_missing_session_ref() {
        let mut item = work_item("work:1", "task:1");
        item.refs.session_id = None;

        let projection = item.runtime_projection();

        assert_eq!(
            projection.state,
            EngineTaskWorkItemRuntimeLinkState::RepairRequired(
                "work item is missing an agent session ref".to_owned()
            )
        );
    }

    #[test]
    fn review_acceptance_is_distinct_from_task_completion() {
        let item = work_item("work:1", "task:1");

        let transition = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:effigy:qa".to_owned()],
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:review".to_owned())],
                diff_summary_ids: Vec::new(),
                note: Some("accepted after validation".to_owned()),
            })
            .expect("review transition");

        assert_eq!(
            transition.from,
            EngineTaskWorkItemReviewState::AwaitingReview
        );
        assert_eq!(transition.to, EngineTaskWorkItemReviewState::Accepted);
        assert_eq!(
            transition.work_item.review,
            EngineTaskWorkItemReviewState::Accepted
        );
        assert!(!transition.task_completion_allowed);
        assert!(transition
            .work_item
            .refs
            .checkpoint_ids
            .contains(&EngineCheckpointRecordId("checkpoint:review".to_owned())));
    }

    #[test]
    fn review_records_rejected_needs_changes_and_abandoned_outcomes() {
        let item = work_item("work:1", "task:1");

        let rejected = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Reject {
                    reason: "wrong approach".to_owned(),
                },
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                diff_summary_ids: Vec::new(),
                note: None,
            })
            .expect("reject");
        let needs_changes = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::NeedsChanges {
                    reason: "tests missing".to_owned(),
                },
                validation_refs: Vec::new(),
                checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:review".to_owned())],
                diff_summary_ids: Vec::new(),
                note: None,
            })
            .expect("needs changes");
        let abandoned = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Abandon {
                    reason: "superseded".to_owned(),
                },
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                diff_summary_ids: Vec::new(),
                note: None,
            })
            .expect("abandon");

        assert_eq!(
            rejected.to,
            EngineTaskWorkItemReviewState::Rejected("wrong approach".to_owned())
        );
        assert_eq!(
            needs_changes.to,
            EngineTaskWorkItemReviewState::NeedsChanges("tests missing".to_owned())
        );
        assert_eq!(
            abandoned.to,
            EngineTaskWorkItemReviewState::Abandoned("superseded".to_owned())
        );
    }

    #[test]
    fn review_requires_completed_runtime_and_evidence() {
        let mut item = work_item("work:1", "task:1");
        item.runtime = EngineTaskWorkItemRuntimeState::Running;

        let error = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: vec!["validation:manual".to_owned()],
                checkpoint_ids: Vec::new(),
                diff_summary_ids: Vec::new(),
                note: None,
            })
            .expect_err("running runtime cannot be reviewed");
        assert_eq!(error, EngineTaskWorkItemReviewError::RuntimeNotComplete);

        item.runtime = EngineTaskWorkItemRuntimeState::Completed;
        let error = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::Accept,
                validation_refs: Vec::new(),
                checkpoint_ids: Vec::new(),
                diff_summary_ids: Vec::new(),
                note: None,
            })
            .expect_err("review evidence required");
        assert_eq!(error, EngineTaskWorkItemReviewError::MissingReviewEvidence);
    }

    #[test]
    fn review_can_use_diff_summary_evidence_without_scm_mutation() {
        let item = work_item("work:1", "task:1");

        let transition = item
            .apply_review_decision(EngineTaskWorkItemReviewDecision {
                reviewer_ref: "operator:tom".to_owned(),
                outcome: EngineTaskWorkItemReviewOutcome::NeedsChanges {
                    reason: "diff shows missing docs".to_owned(),
                },
                validation_refs: Vec::new(),
                checkpoint_ids: Vec::new(),
                diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:review".to_owned())],
                note: None,
            })
            .expect("diff evidence can support review");

        assert_eq!(
            transition.to,
            EngineTaskWorkItemReviewState::NeedsChanges("diff shows missing docs".to_owned())
        );
        assert!(transition
            .work_item
            .refs
            .diff_summary_ids
            .contains(&EngineDiffSummaryRecordId("diff:review".to_owned())));
        assert!(!transition.task_completion_allowed);
    }

    #[test]
    fn review_command_rejects_unexpected_review_state() {
        let item = work_item("work:1", "task:1");

        let error = item
            .apply_review_command(EngineTaskWorkItemReviewCommand {
                command_id: "command:review".to_owned(),
                work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
                expected_review: Some(EngineTaskWorkItemReviewState::Accepted),
                decision: EngineTaskWorkItemReviewDecision {
                    reviewer_ref: "operator:tom".to_owned(),
                    outcome: EngineTaskWorkItemReviewOutcome::Accept,
                    validation_refs: vec!["validation:manual".to_owned()],
                    checkpoint_ids: Vec::new(),
                    diff_summary_ids: Vec::new(),
                    note: None,
                },
            })
            .expect_err("expected review state mismatch");

        assert_eq!(error, EngineTaskWorkItemReviewError::ReviewStateConflict);
    }

    #[test]
    fn review_transition_projects_to_timeline_entry() {
        let item = work_item("work:1", "task:1");
        let transition = item
            .apply_review_command(EngineTaskWorkItemReviewCommand {
                command_id: "command:review".to_owned(),
                work_item_id: EngineTaskWorkItemId("work:1".to_owned()),
                expected_review: Some(EngineTaskWorkItemReviewState::AwaitingReview),
                decision: EngineTaskWorkItemReviewDecision {
                    reviewer_ref: "operator:tom".to_owned(),
                    outcome: EngineTaskWorkItemReviewOutcome::Accept,
                    validation_refs: Vec::new(),
                    checkpoint_ids: vec![EngineCheckpointRecordId("checkpoint:review".to_owned())],
                    diff_summary_ids: vec![EngineDiffSummaryRecordId("diff:review".to_owned())],
                    note: None,
                },
            })
            .expect("review command");

        let entry = review_timeline_entry_from_transition("command:review", &transition);

        assert_eq!(entry.task_id, TaskId("task:1".to_owned()));
        assert_eq!(entry.work_item_id, EngineTaskWorkItemId("work:1".to_owned()));
        assert_eq!(entry.source_command_id, "command:review");
        assert_eq!(entry.review_state, EngineTaskWorkItemReviewState::Accepted);
        assert_eq!(
            entry.diff_summary_ids,
            vec![EngineDiffSummaryRecordId("diff:review".to_owned())]
        );
    }
