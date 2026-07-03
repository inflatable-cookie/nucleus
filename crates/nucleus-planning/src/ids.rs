//! Structured planning identity types.

/// Stable guided planning session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PlanningSessionId(pub String);

/// Stable open-ended exploration session id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExplorationSessionId(pub String);

/// Stable planning artifact id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PlanningArtifactId(pub String);

/// Stable planning task seed id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PlanningTaskSeedId(pub String);

/// Stable shared memory proposal id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MemoryProposalId(pub String);

/// Stable research run brief id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchRunBriefId(pub String);

/// Stable exploration question id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExplorationQuestionId(pub String);

/// Stable exploration assumption id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExplorationAssumptionId(pub String);

/// Stable exploration option id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExplorationOptionId(pub String);

/// Stable exploration note id for risks, opportunities, and constraints.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ExplorationNoteId(pub String);

/// Stable planning decision reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PlanningDecisionId(pub String);

/// Stable goal reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PlanningGoalId(pub String);

/// Stable roadmap branch reference id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct RoadmapBranchId(pub String);
