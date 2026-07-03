use nucleus_projects::ProjectId;

use crate::{
    ExplorationAssumption, ExplorationAssumptionId, ExplorationConfidence, ExplorationMode,
    ExplorationNote, ExplorationNoteId, ExplorationNoteKind, ExplorationOption,
    ExplorationOptionId, ExplorationOptionStatus, ExplorationPriority, ExplorationPromotionRefs,
    ExplorationQuestion, ExplorationQuestionId, ExplorationQuestionStatus, ExplorationSession,
    ExplorationSessionId, ExplorationSessionStatus, ExplorationSessionTimestamps,
    ExplorationTradeoff, ExplorationTradeoffPosture, MemoryProposalId, PlanningArtifactId,
    PlanningDecisionId, PlanningGoalId, PlanningOutputRefs, PlanningParticipantRef,
    PlanningParticipantRole, PlanningSession, PlanningSessionId, PlanningSessionKind,
    PlanningSessionStatus, PlanningSessionTimestamps, PlanningSourceKind, PlanningSourceRef,
    PlanningTaskSeedId, ResearchRunBriefId, RoadmapBranchId,
};

use super::*;

#[test]
fn planning_session_storage_codec_preserves_structured_refs() {
    let session = PlanningSession {
        id: PlanningSessionId("planning-session:nucleus:intake".to_owned()),
        project_id: ProjectId("project:nucleus".to_owned()),
        kind: PlanningSessionKind::ProjectIntake,
        status: PlanningSessionStatus::Accepted,
        prompt_or_template_refs: vec!["template:project-intake:v1".to_owned()],
        participants: vec![PlanningParticipantRef {
            actor_ref: "user:tom".to_owned(),
            role: PlanningParticipantRole::Human,
        }],
        source_refs: vec![PlanningSourceRef {
            source_ref: "conversation-summary:intake".to_owned(),
            kind: PlanningSourceKind::ConversationSummary,
        }],
        output_refs: PlanningOutputRefs {
            artifact_refs: vec![PlanningArtifactId("artifact:vision:v1".to_owned())],
            task_seed_refs: vec![PlanningTaskSeedId("seed:planning:task".to_owned())],
            memory_proposal_refs: vec![MemoryProposalId("memory:proposal:one".to_owned())],
            research_run_brief_refs: vec![ResearchRunBriefId("research:brief:one".to_owned())],
        },
        timestamps: PlanningSessionTimestamps {
            created_at: None,
            updated_at: None,
            accepted_at: None,
        },
    };

    let bytes = encode_planning_session_storage_record(&session).expect("encode session");
    let decoded = decode_planning_session_storage_record(&bytes).expect("decode session");

    assert_eq!(decoded.schema_version, PLANNING_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.session_id, "planning-session:nucleus:intake");
    assert_eq!(decoded.project_id, "project:nucleus");
    assert_eq!(decoded.kind, PlanningSessionStorageKind::ProjectIntake);
    assert_eq!(decoded.status, PlanningSessionStorageStatus::Accepted);
    assert_eq!(
        decoded.prompt_or_template_refs,
        ["template:project-intake:v1"]
    );
    assert_eq!(decoded.participants[0].actor_ref, "user:tom");
    assert_eq!(
        decoded.output_refs.artifact_refs,
        ["artifact:vision:v1".to_owned()]
    );
    assert_eq!(
        decoded.output_refs.task_seed_refs,
        ["seed:planning:task".to_owned()]
    );
}

#[test]
fn exploration_storage_codec_preserves_questions_options_and_promotions() {
    let session = ExplorationSession {
        id: ExplorationSessionId("exploration:nucleus:planning-ui".to_owned()),
        project_id: Some(ProjectId("project:nucleus".to_owned())),
        title: "Planning surface direction".to_owned(),
        scope_prompt: "Explore the guided planning surface.".to_owned(),
        mode: ExplorationMode::ProductIdeation,
        status: ExplorationSessionStatus::AwaitingPromotionReview,
        participants: vec![PlanningParticipantRef {
            actor_ref: "agent:planner".to_owned(),
            role: PlanningParticipantRole::Agent,
        }],
        source_conversation_refs: vec![PlanningSourceRef {
            source_ref: "conversation-summary:planning-ui".to_owned(),
            kind: PlanningSourceKind::ConversationSummary,
        }],
        questions: vec![ExplorationQuestion {
            id: ExplorationQuestionId("question:planning-ui:scope".to_owned()),
            text: "How much ideation should be structured?".to_owned(),
            status: ExplorationQuestionStatus::NeedsResearch,
            priority: ExplorationPriority::High,
            blocker: false,
            evidence_refs: vec!["evidence:planning-dialog".to_owned()],
        }],
        assumptions: vec![ExplorationAssumption {
            id: ExplorationAssumptionId("assumption:planning:guided".to_owned()),
            statement: "Guided planning reduces drift.".to_owned(),
            confidence: ExplorationConfidence::Medium,
            evidence_refs: vec!["evidence:operator-feedback".to_owned()],
            challenge_refs: Vec::new(),
        }],
        options: vec![ExplorationOption {
            id: ExplorationOptionId("option:planning:board".to_owned()),
            title: "Planning board".to_owned(),
            summary: "Use a structured board before task promotion.".to_owned(),
            tradeoffs: vec![ExplorationTradeoff {
                label: "structure".to_owned(),
                posture: ExplorationTradeoffPosture::Supports,
                detail: "Keeps open exploration visible.".to_owned(),
            }],
            status: ExplorationOptionStatus::Preferred,
            rationale_refs: vec!["rationale:planning-board".to_owned()],
        }],
        notes: vec![ExplorationNote {
            id: ExplorationNoteId("note:planning:overhead".to_owned()),
            kind: ExplorationNoteKind::Risk,
            title: "Workflow overhead".to_owned(),
            body: "Too much structure could slow early ideation.".to_owned(),
            evidence_refs: Vec::new(),
        }],
        promotion_refs: ExplorationPromotionRefs {
            accepted_artifact_refs: vec![PlanningArtifactId("artifact:planning:v1".to_owned())],
            research_run_brief_refs: vec![ResearchRunBriefId("research:planning:v1".to_owned())],
            task_seed_refs: vec![PlanningTaskSeedId("seed:planning:v1".to_owned())],
            memory_proposal_refs: vec![MemoryProposalId("memory:planning:v1".to_owned())],
            decision_refs: vec![PlanningDecisionId("decision:planning:v1".to_owned())],
            goal_refs: vec![PlanningGoalId("goal:planning:v1".to_owned())],
            roadmap_branch_refs: vec![RoadmapBranchId("roadmap:g03:118".to_owned())],
        },
        timestamps: ExplorationSessionTimestamps {
            created_at: None,
            updated_at: None,
            promoted_at: None,
        },
    };

    let bytes = encode_exploration_session_storage_record(&session).expect("encode");
    let decoded = decode_exploration_session_storage_record(&bytes).expect("decode");

    assert_eq!(decoded.schema_version, PLANNING_STORAGE_SCHEMA_VERSION);
    assert_eq!(decoded.session_id, "exploration:nucleus:planning-ui");
    assert_eq!(decoded.project_id.as_deref(), Some("project:nucleus"));
    assert_eq!(decoded.mode, ExplorationStorageMode::ProductIdeation);
    assert_eq!(
        decoded.status,
        ExplorationSessionStorageStatus::AwaitingPromotionReview
    );
    assert_eq!(
        decoded.questions[0].priority,
        ExplorationStoragePriority::High
    );
    assert_eq!(
        decoded.options[0].tradeoffs[0].posture,
        ExplorationTradeoffStoragePosture::Supports
    );
    assert_eq!(
        decoded.promotion_refs.task_seed_refs,
        ["seed:planning:v1".to_owned()]
    );
    assert_eq!(
        decoded.promotion_refs.memory_proposal_refs,
        ["memory:planning:v1".to_owned()]
    );
}

#[test]
fn planning_storage_payload_does_not_require_raw_private_material() {
    let record = PlanningSessionStorageRecord {
        schema_version: PLANNING_STORAGE_SCHEMA_VERSION,
        session_id: "planning-session:safe".to_owned(),
        project_id: "project:nucleus".to_owned(),
        kind: PlanningSessionStorageKind::Ideation,
        status: PlanningSessionStorageStatus::Draft,
        prompt_or_template_refs: Vec::new(),
        participants: Vec::new(),
        source_refs: Vec::new(),
        output_refs: PlanningOutputStorageRefs::default(),
    };

    let bytes = encode_planning_session_storage_payload(&record).expect("encode");
    let json = String::from_utf8(bytes).expect("utf8 json");

    assert!(!json.contains("raw_transcript"));
    assert!(!json.contains("provider_payload"));
    assert!(!json.contains("secret"));
    assert!(!json.contains("private_memory"));
}
