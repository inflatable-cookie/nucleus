//! Source reference vocabulary for memory proposals.
//!
//! Source refs link proposals back to planning, research, task, session,
//! document, and sanitized evidence surfaces without using source ids as
//! durable memory identity.

/// Source reference for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemorySourceRef {
    pub kind: MemorySourceKind,
    pub source_ref: String,
    pub evidence_ref: Option<String>,
}

/// Source category for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MemorySourceKind {
    PlanningSession,
    ExplorationSession,
    PlanningArtifact,
    TaskSeed,
    ResearchBrief,
    Task,
    AgentSession,
    SanitizedEvidence,
    ScmChange,
    Document,
    Custom(String),
}

/// Cross-domain linkage refs for a memory proposal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MemoryLinkRefs {
    pub planning_session_refs: Vec<String>,
    pub exploration_session_refs: Vec<String>,
    pub planning_artifact_refs: Vec<String>,
    pub task_seed_refs: Vec<String>,
    pub research_brief_refs: Vec<String>,
    pub task_refs: Vec<String>,
    pub evidence_refs: Vec<String>,
}

impl MemoryLinkRefs {
    /// Empty linkage refs for a proposal that only has source refs.
    pub fn empty() -> Self {
        Self {
            planning_session_refs: Vec::new(),
            exploration_session_refs: Vec::new(),
            planning_artifact_refs: Vec::new(),
            task_seed_refs: Vec::new(),
            research_brief_refs: Vec::new(),
            task_refs: Vec::new(),
            evidence_refs: Vec::new(),
        }
    }

    /// Linkage refs point at source domains only. They do not grant mutation.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}
