//! Open-ended exploration state.
//!
//! Exploration is distinct from finite task planning. It can preserve
//! questions, assumptions, options, risks, opportunities, and promotion refs
//! without forcing immediate implementation work.

use std::time::SystemTime;

use nucleus_projects::ProjectId;

use crate::ids::{
    ExplorationAssumptionId, ExplorationNoteId, ExplorationOptionId, ExplorationQuestionId,
    ExplorationSessionId, MemoryProposalId, PlanningArtifactId, PlanningDecisionId, PlanningGoalId,
    PlanningTaskSeedId, ResearchRunBriefId, RoadmapBranchId,
};
use crate::refs::{PlanningParticipantRef, PlanningSourceRef};

/// Open-ended exploration session record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationSession {
    pub id: ExplorationSessionId,
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub scope_prompt: String,
    pub mode: ExplorationMode,
    pub status: ExplorationSessionStatus,
    pub participants: Vec<PlanningParticipantRef>,
    pub source_conversation_refs: Vec<PlanningSourceRef>,
    pub questions: Vec<ExplorationQuestion>,
    pub assumptions: Vec<ExplorationAssumption>,
    pub options: Vec<ExplorationOption>,
    pub notes: Vec<ExplorationNote>,
    pub promotion_refs: ExplorationPromotionRefs,
    pub timestamps: ExplorationSessionTimestamps,
}

/// Exploration mode. This is deliberately separate from finite plan mode.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationMode {
    OpenEnded,
    ProblemFraming,
    ProductIdeation,
    ArchitectureExploration,
    ResearchScoping,
    OptionComparison,
    Other(String),
}

/// Exploration lifecycle state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationSessionStatus {
    Draft,
    Active,
    Paused,
    AwaitingPromotionReview,
    Promoted,
    Superseded,
    Archived,
}

/// Question preserved by an exploration session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationQuestion {
    pub id: ExplorationQuestionId,
    pub text: String,
    pub status: ExplorationQuestionStatus,
    pub priority: ExplorationPriority,
    pub blocker: bool,
    pub evidence_refs: Vec<String>,
}

/// Question status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationQuestionStatus {
    Open,
    NeedsResearch,
    Answered,
    Deferred,
    Superseded,
}

/// Assumption captured during exploration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationAssumption {
    pub id: ExplorationAssumptionId,
    pub statement: String,
    pub confidence: ExplorationConfidence,
    pub evidence_refs: Vec<String>,
    pub challenge_refs: Vec<String>,
}

/// Possible option or direction under consideration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationOption {
    pub id: ExplorationOptionId,
    pub title: String,
    pub summary: String,
    pub tradeoffs: Vec<ExplorationTradeoff>,
    pub status: ExplorationOptionStatus,
    pub rationale_refs: Vec<String>,
}

/// Tradeoff for or against an option.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationTradeoff {
    pub label: String,
    pub posture: ExplorationTradeoffPosture,
    pub detail: String,
}

/// Tradeoff direction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationTradeoffPosture {
    Supports,
    Weakens,
    Mixed,
    Unknown,
}

/// Option status.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationOptionStatus {
    Proposed,
    UnderReview,
    Preferred,
    Rejected,
    Deferred,
    Superseded,
}

/// Risk, opportunity, or constraint note.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationNote {
    pub id: ExplorationNoteId,
    pub kind: ExplorationNoteKind,
    pub title: String,
    pub body: String,
    pub evidence_refs: Vec<String>,
}

/// Exploration note kind.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationNoteKind {
    Risk,
    Opportunity,
    Constraint,
    OpenConcern,
    DecisionRef(PlanningDecisionId),
}

/// Promotion refs created from reviewed exploration output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationPromotionRefs {
    pub accepted_artifact_refs: Vec<PlanningArtifactId>,
    pub research_run_brief_refs: Vec<ResearchRunBriefId>,
    pub task_seed_refs: Vec<PlanningTaskSeedId>,
    pub memory_proposal_refs: Vec<MemoryProposalId>,
    pub decision_refs: Vec<PlanningDecisionId>,
    pub goal_refs: Vec<PlanningGoalId>,
    pub roadmap_branch_refs: Vec<RoadmapBranchId>,
}

impl ExplorationPromotionRefs {
    /// Empty promotion refs for an exploration session with no accepted output.
    pub fn empty() -> Self {
        Self {
            accepted_artifact_refs: Vec::new(),
            research_run_brief_refs: Vec::new(),
            task_seed_refs: Vec::new(),
            memory_proposal_refs: Vec::new(),
            decision_refs: Vec::new(),
            goal_refs: Vec::new(),
            roadmap_branch_refs: Vec::new(),
        }
    }

    /// Whether any reviewed output has been promoted into a pathway source.
    pub fn has_accepted_pathway(&self) -> bool {
        !self.accepted_artifact_refs.is_empty()
            || !self.research_run_brief_refs.is_empty()
            || !self.task_seed_refs.is_empty()
            || !self.decision_refs.is_empty()
            || !self.goal_refs.is_empty()
            || !self.roadmap_branch_refs.is_empty()
    }
}

/// Coarse priority used before scoring policy exists.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationPriority {
    Low,
    Normal,
    High,
    Blocking,
}

/// Coarse confidence signal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExplorationConfidence {
    Unknown,
    Low,
    Medium,
    High,
}

/// Exploration timestamps.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExplorationSessionTimestamps {
    pub created_at: Option<SystemTime>,
    pub updated_at: Option<SystemTime>,
    pub promoted_at: Option<SystemTime>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::refs::{PlanningParticipantRole, PlanningSourceKind};

    #[test]
    fn exploration_session_can_preserve_open_questions_without_next_task() {
        let session = ExplorationSession {
            id: ExplorationSessionId("exploration:nucleus:planning-ui".to_owned()),
            project_id: Some(ProjectId("project:nucleus".to_owned())),
            title: "Planning surface direction".to_owned(),
            scope_prompt: "Explore how Nucleus should support early project thinking.".to_owned(),
            mode: ExplorationMode::ProductIdeation,
            status: ExplorationSessionStatus::Active,
            participants: vec![PlanningParticipantRef {
                actor_ref: "user:tom".to_owned(),
                role: PlanningParticipantRole::Human,
            }],
            source_conversation_refs: vec![PlanningSourceRef {
                source_ref: "conversation-summary:planning-surface".to_owned(),
                kind: PlanningSourceKind::ConversationSummary,
            }],
            questions: vec![ExplorationQuestion {
                id: ExplorationQuestionId("question:planning-ui:retention".to_owned()),
                text: "How much brainstorming history should be retained?".to_owned(),
                status: ExplorationQuestionStatus::Open,
                priority: ExplorationPriority::High,
                blocker: false,
                evidence_refs: Vec::new(),
            }],
            assumptions: Vec::new(),
            options: Vec::new(),
            notes: Vec::new(),
            promotion_refs: ExplorationPromotionRefs::empty(),
            timestamps: ExplorationSessionTimestamps {
                created_at: None,
                updated_at: None,
                promoted_at: None,
            },
        };

        assert_eq!(session.mode, ExplorationMode::ProductIdeation);
        assert_eq!(session.questions.len(), 1);
        assert!(!session.promotion_refs.has_accepted_pathway());
    }

    #[test]
    fn exploration_session_preserves_multiple_options_and_tradeoffs() {
        let options = vec![
            ExplorationOption {
                id: ExplorationOptionId("option:guided-wizard".to_owned()),
                title: "Guided wizard".to_owned(),
                summary: "Constrain early project setup through structured prompts.".to_owned(),
                tradeoffs: vec![ExplorationTradeoff {
                    label: "focus".to_owned(),
                    posture: ExplorationTradeoffPosture::Supports,
                    detail: "Keeps new projects from becoming a blank chat.".to_owned(),
                }],
                status: ExplorationOptionStatus::UnderReview,
                rationale_refs: Vec::new(),
            },
            ExplorationOption {
                id: ExplorationOptionId("option:whiteboard".to_owned()),
                title: "Open planning board".to_owned(),
                summary: "Let users explore options spatially before promotion.".to_owned(),
                tradeoffs: vec![ExplorationTradeoff {
                    label: "scope".to_owned(),
                    posture: ExplorationTradeoffPosture::Mixed,
                    detail: "More expressive, but harder to implement early.".to_owned(),
                }],
                status: ExplorationOptionStatus::UnderReview,
                rationale_refs: Vec::new(),
            },
        ];

        assert_eq!(options.len(), 2);
        assert!(options
            .iter()
            .any(|option| option.id.0 == "option:guided-wizard"));
        assert!(options
            .iter()
            .any(|option| option.tradeoffs[0].posture == ExplorationTradeoffPosture::Mixed));
    }

    #[test]
    fn promotion_refs_are_explicit_pathway_sources() {
        let mut refs = ExplorationPromotionRefs::empty();
        assert!(!refs.has_accepted_pathway());

        refs.task_seed_refs
            .push(PlanningTaskSeedId("seed:planning:review-ui".to_owned()));

        assert!(refs.has_accepted_pathway());
        assert!(refs.memory_proposal_refs.is_empty());
    }
}
