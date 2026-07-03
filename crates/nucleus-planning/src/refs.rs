//! Cross-domain planning reference types.
//!
//! References point at evidence or promotion targets. They do not grant
//! authority to mutate the referenced domain.

use crate::ids::{MemoryProposalId, PlanningArtifactId, PlanningTaskSeedId, ResearchRunBriefId};

/// Actor or system that participated in planning.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningParticipantRef {
    pub actor_ref: String,
    pub role: PlanningParticipantRole,
}

/// Participant role in a planning session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningParticipantRole {
    Human,
    Agent,
    Steward,
    Harness,
    System,
    Other(String),
}

/// Source material linked to a planning session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningSourceRef {
    pub source_ref: String,
    pub kind: PlanningSourceKind,
}

/// Source category. Raw transcript refs remain evidence, not authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PlanningSourceKind {
    OperatorPrompt,
    ConversationSummary,
    TranscriptRef,
    ExistingDocument,
    ResearchRun,
    Memory,
    Task,
    ProjectionFile,
    Other(String),
}

/// Outputs linked from a planning session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanningOutputRefs {
    pub artifact_refs: Vec<PlanningArtifactId>,
    pub task_seed_refs: Vec<PlanningTaskSeedId>,
    pub memory_proposal_refs: Vec<MemoryProposalId>,
    pub research_run_brief_refs: Vec<ResearchRunBriefId>,
}

impl PlanningOutputRefs {
    /// Empty output refs for a session that has not produced reviewed outputs.
    pub fn empty() -> Self {
        Self {
            artifact_refs: Vec::new(),
            task_seed_refs: Vec::new(),
            memory_proposal_refs: Vec::new(),
            research_run_brief_refs: Vec::new(),
        }
    }
}
