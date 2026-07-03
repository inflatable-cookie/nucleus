//! Stable identifier vocabulary for research records.

/// Stable server-assigned research run brief id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchRunBriefId(pub String);

/// Stable research question id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchQuestionId(pub String);

/// Stable source record id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchSourceId(pub String);

/// Stable observation id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchObservationId(pub String);

/// Stable synthesis artifact id.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ResearchSynthesisId(pub String);
