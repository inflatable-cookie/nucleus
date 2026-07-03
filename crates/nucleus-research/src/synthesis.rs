//! Research observations and synthesis records.
//!
//! Observations and synthesis distinguish evidence, inference, speculation,
//! and recommendation without mutating planning, memory, tasks, docs, or
//! projection files directly.

use crate::ids::{
    ResearchObservationId, ResearchRunBriefId, ResearchSourceId, ResearchSynthesisId,
};
use crate::refs::ResearchPromotionTargetRefs;
use crate::runs::ResearchConfidence;

/// Extracted claim, fact, comparison, or finding tied to source refs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchObservation {
    pub id: ResearchObservationId,
    pub run_id: ResearchRunBriefId,
    pub source_refs: Vec<ResearchSourceId>,
    pub kind: ResearchObservationKind,
    pub summary: String,
    pub evidence_ref: Option<String>,
}

impl ResearchObservation {
    /// Observations classify evidence. They do not mutate source, planning,
    /// memory, task, docs, or projection records.
    pub fn grants_mutation_authority(&self) -> bool {
        false
    }
}

/// Observation classification.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchObservationKind {
    Evidence,
    Inference,
    Speculation,
    Recommendation,
}

/// Linked synthesis artifact ref.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchSynthesisRef {
    pub id: ResearchSynthesisId,
    pub run_id: ResearchRunBriefId,
    pub kind: ResearchSynthesisKind,
    pub observation_refs: Vec<ResearchObservationId>,
    pub source_coverage_refs: Vec<ResearchSourceId>,
    pub confidence: ResearchConfidence,
    pub gap_refs: Vec<String>,
    pub promotion_targets: ResearchPromotionTargetRefs,
}

impl ResearchSynthesisRef {
    /// Synthesis refs are candidate outputs only. Target domains decide
    /// whether any promotion happens.
    pub fn grants_promotion_authority(&self) -> bool {
        false
    }
}

/// Synthesis category.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResearchSynthesisKind {
    Answer,
    Recommendation,
    DecisionSupport,
    PlanningInput,
    TaskSeedGroup,
    Custom(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation() -> ResearchObservation {
        ResearchObservation {
            id: ResearchObservationId("research-observation:harness:identity".to_owned()),
            run_id: ResearchRunBriefId("research-run:harness".to_owned()),
            source_refs: vec![ResearchSourceId("research-source:harness:docs".to_owned())],
            kind: ResearchObservationKind::Evidence,
            summary: "Harness docs describe session ids.".to_owned(),
            evidence_ref: Some("evidence:classified-docs".to_owned()),
        }
    }

    #[test]
    fn observations_classify_findings_without_mutation() {
        let observation = observation();

        assert_eq!(observation.kind, ResearchObservationKind::Evidence);
        assert!(!observation.grants_mutation_authority());
    }

    #[test]
    fn synthesis_links_refs_without_promotion_authority() {
        let observation = observation();
        let synthesis = ResearchSynthesisRef {
            id: ResearchSynthesisId("research-synthesis:harness:identity".to_owned()),
            run_id: observation.run_id.clone(),
            kind: ResearchSynthesisKind::DecisionSupport,
            observation_refs: vec![observation.id],
            source_coverage_refs: observation.source_refs,
            confidence: ResearchConfidence::Medium,
            gap_refs: vec!["gap:cursor-tool-call-ids".to_owned()],
            promotion_targets: ResearchPromotionTargetRefs {
                memory_proposal_refs: vec!["memory-proposal:harness-identity".to_owned()],
                planning_artifact_refs: vec!["planning-artifact:harness-contract".to_owned()],
                task_seed_refs: vec!["task-seed:adapter-fixtures".to_owned()],
                source_evidence_refs: vec!["evidence:classified-docs".to_owned()],
            },
        };

        assert_eq!(synthesis.kind, ResearchSynthesisKind::DecisionSupport);
        assert!(!synthesis.grants_promotion_authority());
        assert!(!synthesis.promotion_targets.grants_mutation_authority());
    }
}
