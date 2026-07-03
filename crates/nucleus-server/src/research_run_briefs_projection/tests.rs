use nucleus_projects::ProjectId;
use nucleus_research::{
    ResearchConfidenceStorage, ResearchCoverageStorageSummary, ResearchObservationStorageKind,
    ResearchObservationStorageRecord, ResearchPromotionTargetStorageRefs,
    ResearchQuestionStoragePriority, ResearchQuestionStorageRecord, ResearchQuestionStorageStatus,
    ResearchRetrievalStorageMethodHint, ResearchRunBriefStorageRecord,
    ResearchRunBriefStorageStatus, ResearchRunScopeStorageBoundary, ResearchSourceStorageKind,
    ResearchSourceStorageRef, ResearchSourceStorageReliability, ResearchSynthesisStorageKind,
    ResearchSynthesisStorageRef,
};

use super::*;

#[test]
fn projection_reports_sanitized_counts_only() {
    let projection = ResearchRunBriefsProjection::from_storage_records(
        ProjectId("project:nucleus".to_owned()),
        vec![record("project:nucleus"), record("project:other")],
    );

    assert_eq!(projection.runs.len(), 1);
    assert_eq!(projection.runs[0].run_id, "research-run:project:nucleus");
    assert_eq!(projection.source_counts.run_records, 1);
    assert_eq!(projection.source_counts.questions, 1);
    assert_eq!(projection.source_counts.source_refs, 1);
    assert_eq!(projection.source_counts.observation_refs, 1);
    assert_eq!(projection.source_counts.synthesis_refs, 1);
    assert_eq!(projection.source_counts.promotion_target_refs, 4);
    assert!(!projection.client_can_mutate);
    assert!(!projection.provider_execution_available);
}

fn record(project_id: &str) -> ResearchRunBriefStorageRecord {
    ResearchRunBriefStorageRecord {
        schema_version: 1,
        run_id: format!("research-run:{project_id}"),
        project_id: Some(project_id.to_owned()),
        title: "Hidden from query".to_owned(),
        brief_summary: "Hidden from query".to_owned(),
        brief_detail: Some("Hidden from query".to_owned()),
        status: ResearchRunBriefStorageStatus::Proposed,
        scope_boundary: ResearchRunScopeStorageBoundary::default(),
        source_plan_refs: vec!["source-plan:harness".to_owned()],
        confidence: ResearchConfidenceStorage::Unknown,
        coverage: ResearchCoverageStorageSummary {
            covered_refs: vec!["source:docs".to_owned()],
            gap_refs: vec!["gap:identity".to_owned()],
            note: None,
        },
        questions: vec![ResearchQuestionStorageRecord {
            question_id: "question:identity".to_owned(),
            run_id: format!("research-run:{project_id}"),
            text: "Hidden from query".to_owned(),
            priority: ResearchQuestionStoragePriority::High,
            status: ResearchQuestionStorageStatus::Open,
            source_requirements: Vec::new(),
            answer_summary: None,
            evidence_refs: Vec::new(),
            open_gap_refs: vec!["gap:question".to_owned()],
        }],
        source_refs: vec![ResearchSourceStorageRef {
            source_id: "source:docs".to_owned(),
            run_id: format!("research-run:{project_id}"),
            kind: ResearchSourceStorageKind::OfficialDocs,
            locator: "Hidden from query".to_owned(),
            accessed_at: None,
            author_or_publisher: None,
            published_or_updated_at: None,
            retrieval_method: ResearchRetrievalStorageMethodHint::Manual,
            reliability: ResearchSourceStorageReliability::Official,
            quote_or_license_note: None,
            retained_artifact_refs: Vec::new(),
        }],
        observation_refs: vec![ResearchObservationStorageRecord {
            observation_id: "observation:identity".to_owned(),
            run_id: format!("research-run:{project_id}"),
            source_refs: vec!["source:docs".to_owned()],
            kind: ResearchObservationStorageKind::Evidence,
            summary: "Hidden from query".to_owned(),
            evidence_ref: Some("evidence:docs".to_owned()),
        }],
        synthesis_refs: vec![ResearchSynthesisStorageRef {
            synthesis_id: "synthesis:identity".to_owned(),
            run_id: format!("research-run:{project_id}"),
            kind: ResearchSynthesisStorageKind::DecisionSupport,
            observation_refs: vec!["observation:identity".to_owned()],
            source_coverage_refs: vec!["source:docs".to_owned()],
            confidence: ResearchConfidenceStorage::Medium,
            gap_refs: vec!["gap:synthesis".to_owned()],
            promotion_targets: ResearchPromotionTargetStorageRefs {
                memory_proposal_refs: vec!["memory:proposal".to_owned()],
                planning_artifact_refs: vec!["planning:artifact".to_owned()],
                task_seed_refs: vec!["task:seed".to_owned()],
                source_evidence_refs: vec!["evidence:docs".to_owned()],
            },
        }],
        created_at: None,
        updated_at: None,
        synthesized_at: None,
        accepted_at: None,
    }
}
